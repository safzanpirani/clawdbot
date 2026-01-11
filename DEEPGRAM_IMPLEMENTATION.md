# Deepgram Transcription Provider Implementation

This guide documents how to add Deepgram as a native audio transcription provider to Clawdbot.

## Progress Checklist

- [x] Add `@deepgram/sdk` dependency (`pnpm add -w @deepgram/sdk`)
- [x] Add types to `src/config/types.ts`
- [x] Add zod schema to `src/config/zod-schema.ts`
- [x] Create `src/auto-reply/transcription-deepgram.ts`
- [x] Update `src/auto-reply/transcription.ts` to support provider switching
- [x] Run lint/build/test
- [ ] Commit and push to fork
- [ ] (Later) Create PR to upstream after review

---

## 1. Types (`src/config/types.ts`)

Add before `ToolsConfig`:

```typescript
export type TranscriptionProvider = "command" | "deepgram" | "openai";

export type DeepgramTranscriptionConfig = {
  apiKey?: string;
  model?: string;
  language?: string;
  detectLanguage?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
};

export type TranscriptionConfig = {
  provider?: TranscriptionProvider;
  args?: string[];
  deepgram?: DeepgramTranscriptionConfig;
  timeoutSeconds?: number;
};
```

Update `ToolsConfig.audio.transcription` to use `TranscriptionConfig`:

```typescript
export type ToolsConfig = {
  // ...existing fields...
  audio?: {
    transcription?: TranscriptionConfig;
  };
  // ...rest...
};
```

---

## 2. Zod Schema (`src/config/zod-schema.ts`)

Find `ToolsAudioTranscriptionSchema` (around line 262) and replace:

```typescript
const DeepgramTranscriptionSchema = z
  .object({
    apiKey: z.string().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
    detectLanguage: z.boolean().optional(),
    punctuate: z.boolean().optional(),
    smartFormat: z.boolean().optional(),
  })
  .optional();

const ToolsAudioTranscriptionSchema = z
  .object({
    provider: z
      .union([z.literal("command"), z.literal("deepgram"), z.literal("openai")])
      .optional(),
    args: z.array(z.string()).optional(),
    deepgram: DeepgramTranscriptionSchema,
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional();
```

---

## 3. Deepgram Provider (`src/auto-reply/transcription-deepgram.ts`)

Create new file:

```typescript
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
```

---

## 4. Update Main Transcription (`src/auto-reply/transcription.ts`)

Add import at top:

```typescript
import { transcribeWithDeepgram } from "./transcription-deepgram.js";
```

Update `hasAudioTranscriptionConfig`:

```typescript
export function hasAudioTranscriptionConfig(cfg: ClawdbotConfig): boolean {
  const transcription = cfg.tools?.audio?.transcription;
  if (transcription) {
    if (transcription.args?.length) return true;
    if (transcription.provider === "deepgram") {
      return Boolean(transcription.deepgram?.apiKey || process.env.DEEPGRAM_API_KEY);
    }
    if (transcription.provider === "openai") return true;
  }
  return Boolean(cfg.audio?.transcription?.command?.length);
}
```

Update `transcribeInboundAudio` to add provider switch after resolving media path:

```typescript
// Inside transcribeInboundAudio, after getting mediaPath:

const provider = toolTranscriber?.provider ?? "command";

switch (provider) {
  case "deepgram":
    return await transcribeWithDeepgram(mediaPath, toolTranscriber?.deepgram, timeoutMs);

  case "openai":
    runtime.error?.("OpenAI transcription provider not yet implemented");
    return undefined;

  case "command":
  default:
    // existing whisper/command logic
    break;
}
```

---

## 5. Config Example

User config at `~/.clawdbot/clawdbot.json`:

```json
{
  "tools": {
    "audio": {
      "transcription": {
        "provider": "deepgram",
        "deepgram": {
          "model": "nova-3",
          "language": "multi",
          "detectLanguage": true,
          "punctuate": true,
          "smartFormat": true
        },
        "timeoutSeconds": 60
      }
    }
  }
}
```

Or use env var: `DEEPGRAM_API_KEY=your-key`

---

## 6. Verification Commands

```bash
pnpm lint
pnpm build
pnpm test
```

---

## 7. Commit

```bash
git add -A
git commit -m "feat(transcription): add Deepgram as native audio transcription provider"
git push safzan main
```

---

## Notes

- Deepgram SDK v4.x uses `createClient()` and `listen.prerecorded.transcribeFile()`
- The `nova-3` model is Deepgram's latest and most accurate
- `language: "multi"` enables multi-language detection
- Timeout wraps the API call with Promise.race
- Falls back to `DEEPGRAM_API_KEY` env var if config key not set
