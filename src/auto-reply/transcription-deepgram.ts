import fs from "node:fs/promises";

import { createClient, type DeepgramClient } from "@deepgram/sdk";

import type { DeepgramTranscribeConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";

let cachedClient: DeepgramClient | undefined;

function getClient(apiKey?: string): DeepgramClient {
  const key = apiKey ?? process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error(
      "Deepgram API key required: set routing.transcribeAudio.deepgram.apiKey or DEEPGRAM_API_KEY env var",
    );
  }
  if (!cachedClient) {
    cachedClient = createClient(key);
  }
  return cachedClient;
}

export async function transcribeWithDeepgram(
  filePath: string,
  config: DeepgramTranscribeConfig = {},
  timeoutMs: number = 45_000,
): Promise<{ text: string } | undefined> {
  const client = getClient(config.apiKey);

  const audioBuffer = await fs.readFile(filePath);

  if (shouldLogVerbose()) {
    logVerbose(
      `Transcribing audio via Deepgram (${(audioBuffer.length / 1024).toFixed(1)}KB, model=${config.model ?? "nova-3"})`,
    );
  }

  const transcribePromise = client.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: config.model ?? "nova-3",
      language: config.detectLanguage ? undefined : (config.language ?? "en"),
      detect_language: config.detectLanguage ?? false,
      punctuate: config.punctuate ?? true,
      smart_format: config.smartFormat ?? true,
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Deepgram transcription timed out")), timeoutMs),
  );

  const { result, error } = await Promise.race([transcribePromise, timeoutPromise]);

  if (error) {
    throw new Error(`Deepgram transcription failed: ${error.message}`);
  }

  const transcript =
    result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

  if (!transcript) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`Deepgram transcript: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"`);
  }

  return { text: transcript };
}
