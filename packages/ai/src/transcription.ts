import { cloudflareGatewayConfig } from "@alfred/env/server";
import { transcribe } from "ai";

import { createGateway } from "./gateway";

/**
 * Speech-to-text for the chat composer's voice input.
 *
 * Runs on OpenAI `gpt-4o-mini-transcribe` — same Whisper-family quality as
 * `whisper-1` but cheaper and with better punctuation on short conversational
 * clips, which is exactly what a composer dictation produces. The SDK sniffs
 * the container format (webm/opus from Chrome, mp4/m4a from Safari) from the
 * byte signature, so callers just hand over the recorded bytes.
 *
 * Routes via Cloudflare AI Gateway when configured (same `createGateway`
 * seam as the chat text models — `.../openai` is a pass-through, so
 * `/audio/transcriptions` proxies like `/chat/completions` does), otherwise
 * falls back to the direct provider default, which reads `OPENAI_API_KEY`.
 * Callers gate on `cloudflareGatewayEnabled() || OPENAI_API_KEY` and surface
 * a friendly error when neither is present.
 */
export interface TranscribeAudioResult {
  text: string;
  /** Clip length as reported by the provider; undefined when not returned. */
  durationInSeconds: number | undefined;
}

const TRANSCRIBE_TIMEOUT_MS = 300_000;

export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  const openai = createGateway(cloudflareGatewayConfig()).createOpenAI();
  const result = await transcribe({
    model: openai.transcription("gpt-4o-mini-transcribe"),
    audio,
    abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  return { text: result.text, durationInSeconds: result.durationInSeconds };
}
