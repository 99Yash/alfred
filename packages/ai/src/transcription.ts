import type { OpenAIProvider } from "@ai-sdk/openai";
import { getStringPath, httpErrorFromResponse } from "@alfred/contracts";
import { transcribe } from "ai";

import type { GatewayConfig } from "./gateway";

/**
 * Speech-to-text for composer voice input. `gateway.ts` picks the transport.
 * With Cloudflare, this POSTs `/ai/run`: the OpenAI passthrough sends
 * `/audio/transcriptions` with no key and gets 401. Without it, OpenAI is called directly.
 */
export interface TranscribeAudioResult {
  text: string;

  durationInSeconds: number | undefined;
}

/** Both transports allow 25 MB, but Cloudflare counts the base64 body: 18 MB raw is ~24 MB. */
export const MAX_TRANSCRIBE_AUDIO_BYTES = 18 * 1024 * 1024;

const TRANSCRIBE_TIMEOUT_MS = 300_000;

/** Cloudflare's catalog has no `gpt-4o-mini-transcribe`. */
const CLOUDFLARE_MODEL = "openai/gpt-4o-transcribe";

/** Cheaper than `whisper-1`, with better punctuation on short clips. */
const DIRECT_MODEL = "gpt-4o-mini-transcribe";

/** `fetchImpl` must be the paced fetch: this call uses the same gateway budget as the model calls. */
export async function transcribeViaCloudflareRun(
  gateway: GatewayConfig,
  audio: Uint8Array,
  fetchImpl: typeof globalThis.fetch,
): Promise<TranscribeAudioResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/run`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      "cf-aig-gateway-id": gateway.gatewayId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: CLOUDFLARE_MODEL, input: { file: audioDataUri(audio) } }),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });

  if (!res.ok) throw await httpErrorFromResponse("cloudflare-ai-run", res, { url, method: "POST" });

  const payload: unknown = await res.json();
  const text = getStringPath(payload, "result", "result", "text");

  if (text === undefined) throw new Error("Cloudflare /ai/run returned no transcript");

  // This model returns `{ text }` only.
  return { text, durationInSeconds: undefined };
}

export async function transcribeWithOpenAi(
  openai: OpenAIProvider,
  audio: Uint8Array,
): Promise<TranscribeAudioResult> {
  const result = await transcribe({
    model: openai.transcription(DIRECT_MODEL),
    audio,
    abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });

  return { text: result.text, durationInSeconds: result.durationInSeconds };
}

/** Chrome records WebM/Opus and Safari MP4/AAC. The rest come from dropped files. */
type AudioContainer = "wav" | "ogg" | "flac" | "mp4" | "mp3" | "webm";

/**
 * Not MIME facts: Cloudflare passes the subtype to OpenAI as the file extension.
 * So MP4 must be `m4a`; `audio/mp4` and `audio/x-m4a` fail.
 */
const CONTAINER_DATA_URI_MIME = {
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "audio/m4a",
  mp3: "audio/mp3",
  webm: "audio/webm",
} as const satisfies Record<AudioContainer, string>;

/**
 * Read the container from the bytes. The browser's `mimeType` carries codec params,
 * and Safari's is incomplete.
 * Kept apart from `sniffBinaryType` and `sniffPassThroughImageMime`: each returns different labels.
 */
function sniffAudioContainer(audio: Uint8Array): AudioContainer {
  const at = (offset: number, text: string): boolean =>
    [...text].every((char, i) => audio[offset + i] === char.charCodeAt(0));

  if (at(0, "RIFF") && at(8, "WAVE")) return "wav";

  if (at(0, "OggS")) return "ogg";

  if (at(0, "fLaC")) return "flac";

  if (at(4, "ftyp")) return "mp4";

  if (at(0, "ID3")) return "mp3";

  if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) {
    return "webm"; // EBML: WebM/Matroska
  }

  // MPEG audio frame sync (a bare MP3 with no ID3 tag).
  if (audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0) return "mp3";

  // Chrome is the common recorder, so its container is the safest guess.
  return "webm";
}

function audioDataUri(audio: Uint8Array): string {
  const mime = CONTAINER_DATA_URI_MIME[sniffAudioContainer(audio)];

  return `data:${mime};base64,${Buffer.from(audio).toString("base64")}`;
}
