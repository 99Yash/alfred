import { openai } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";

/**
 * Speech-to-text for the chat composer's voice input.
 *
 * Runs on OpenAI `gpt-4o-mini-transcribe` — same Whisper-family quality as
 * `whisper-1` but cheaper and with better punctuation on short conversational
 * clips, which is exactly what a composer dictation produces. The SDK sniffs
 * the container format (webm/opus from Chrome, mp4/m4a from Safari) from the
 * byte signature, so callers just hand over the recorded bytes.
 *
 * Requires `OPENAI_API_KEY` (the provider reads it the same way the
 * anthropic/google providers do); callers gate on the env var and surface a
 * friendly error when it's missing rather than letting the provider throw.
 */
export interface TranscribeAudioResult {
  text: string;
  /** Clip length as reported by the provider; undefined when not returned. */
  durationInSeconds: number | undefined;
}

const TRANSCRIBE_TIMEOUT_MS = 300_000;

export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  const result = await transcribe({
    model: openai.transcription("gpt-4o-mini-transcribe"),
    audio,
    abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  return { text: result.text, durationInSeconds: result.durationInSeconds };
}
