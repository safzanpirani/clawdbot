import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import type { TranscribeAudioConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { applyTemplate, type MsgContext } from "./templating.js";
import { transcribeWithDeepgram } from "./transcription-deepgram.js";

export function isAudio(mediaType?: string | null) {
  return Boolean(mediaType?.startsWith("audio"));
}

async function resolveMediaPath(
  ctx: MsgContext,
): Promise<{ mediaPath: string; tmpPath?: string } | undefined> {
  if (ctx.MediaPath) {
    return { mediaPath: ctx.MediaPath };
  }

  if (!ctx.MediaUrl) {
    return undefined;
  }

  const res = await fetch(ctx.MediaUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const tmpPath = path.join(
    os.tmpdir(),
    `clawdbot-audio-${crypto.randomUUID()}.ogg`,
  );
  await fs.writeFile(tmpPath, buffer);

  if (shouldLogVerbose()) {
    logVerbose(
      `Downloaded audio for transcription (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) -> ${tmpPath}`,
    );
  }

  return { mediaPath: tmpPath, tmpPath };
}

async function transcribeWithCommand(
  mediaPath: string,
  ctx: MsgContext,
  transcriber: TranscribeAudioConfig,
): Promise<{ text: string } | undefined> {
  if (!transcriber.command?.length) {
    return undefined;
  }

  const timeoutMs = Math.max((transcriber.timeoutSeconds ?? 45) * 1000, 1_000);
  const templCtx: MsgContext = { ...ctx, MediaPath: mediaPath };
  const argv = transcriber.command.map((part) => applyTemplate(part, templCtx));

  if (shouldLogVerbose()) {
    logVerbose(`Transcribing audio via command: ${argv.join(" ")}`);
  }

  const { stdout } = await runExec(argv[0], argv.slice(1), {
    timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  });

  const text = stdout.trim();
  if (!text) return undefined;
  return { text };
}

export async function transcribeInboundAudio(
  cfg: ClawdbotConfig,
  ctx: MsgContext,
  runtime: RuntimeEnv,
): Promise<{ text: string } | undefined> {
  const transcriber = cfg.routing?.transcribeAudio;
  if (!transcriber) return undefined;

  const provider = transcriber.provider ?? "command";

  if (provider === "command" && !transcriber.command?.length) {
    return undefined;
  }

  let tmpPath: string | undefined;

  try {
    const resolved = await resolveMediaPath(ctx);
    if (!resolved) return undefined;

    const { mediaPath } = resolved;
    tmpPath = resolved.tmpPath;

    switch (provider) {
      case "deepgram": {
        const timeoutMs = Math.max((transcriber.timeoutSeconds ?? 45) * 1000, 1_000);
        return await transcribeWithDeepgram(mediaPath, transcriber.deepgram, timeoutMs);
      }

      case "openai":
        runtime.error?.("OpenAI transcription provider not yet implemented");
        return undefined;

      case "command":
      default:
        return await transcribeWithCommand(mediaPath, ctx, transcriber);
    }
  } catch (err) {
    runtime.error?.(`Audio transcription failed: ${String(err)}`);
    return undefined;
  } finally {
    if (tmpPath) {
      void fs.unlink(tmpPath).catch(() => {});
    }
  }
}
