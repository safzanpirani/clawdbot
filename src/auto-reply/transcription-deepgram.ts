import fs from "node:fs/promises";
import { createClient } from "@deepgram/sdk";
import type { DeepgramTranscriptionConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";

export async function transcribeWithDeepgram(
  mediaPath: string,
  config: DeepgramTranscriptionConfig | undefined,
  timeoutMs: number,
): Promise<{ text: string } | undefined> {
  const apiKey = config?.apiKey ?? process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Deepgram API key required: set tools.audio.transcription.deepgram.apiKey or DEEPGRAM_API_KEY env",
    );
  }

  const deepgram = createClient(apiKey);
  const audioBuffer = await fs.readFile(mediaPath);

  if (shouldLogVerbose()) {
    logVerbose(
      `Transcribing ${(audioBuffer.length / 1024).toFixed(1)}KB audio with Deepgram (model: ${config?.model ?? "nova-3"})`,
    );
  }

  const transcribePromise = deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: config?.model ?? "nova-3",
      language: config?.detectLanguage ? undefined : (config?.language ?? "en"),
      detect_language: config?.detectLanguage ?? false,
      punctuate: config?.punctuate ?? true,
      smart_format: config?.smartFormat ?? true,
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("Deepgram transcription timed out")),
      timeoutMs,
    ),
  );

  const { result, error } = await Promise.race([
    transcribePromise,
    timeoutPromise,
  ]);

  if (error) {
    throw new Error(`Deepgram API error: ${error.message}`);
  }

  const transcript =
    result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  if (!transcript.trim()) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(
      `Deepgram transcript: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"`,
    );
  }

  return { text: transcript };
}
