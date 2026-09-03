import type { OpenAIProvider } from "@ai-sdk/openai";
import { getStringPath, httpErrorFromResponse } from "@alfred/contracts";
import { transcribe } from "ai";

import type { GatewayConfig } from "./gateway";

/**
 * Speech-to-text for the chat composer's voice input.
 *
 * This module owns the audio domain: the container sniff, the request each
 * transport sends, and the transcript it reads back. It does NOT choose a
 * transport. `gateway.ts` makes that choice one time and calls one of the two
 * functions below through `Gateway.transcribe`, so no second file decides
 * which host, model, or credential a clip reaches.
 *
 * Two transports exist because Cloudflare attaches a Unified Billing
 * credential per *endpoint*, not per gateway:
 *
 * - **Cloudflare configured** — POST the `/ai/run` universal endpoint. It is
 *   the only Cloudflare surface that serves audio models. The OpenAI
 *   provider-native passthrough (`gateway.ai.cloudflare.com/…/openai/…`) that
 *   the rest of `@alfred/ai` rides gets a managed credential on
 *   `/chat/completions` and `/responses` only; `/audio/transcriptions`
 *   reaches OpenAI with no key at all and returns 401 for every model name.
 *   So this one call leaves the AI SDK. `cf-aig-gateway-id` keeps it in the
 *   gateway's logs and spend limits.
 * - **Not configured** — the direct provider default, which reads
 *   `OPENAI_API_KEY`.
 *
 * Callers ask `transcriptionConfigured()` (also in `gateway.ts`) before they
 * call, and surface a friendly error when neither transport is present.
 */
export interface TranscribeAudioResult {
  text: string;
  /** Clip length as reported by the provider; undefined when not returned. */
  durationInSeconds: number | undefined;
}

/**
 * Largest raw clip either transport accepts, and the only place the number
 * lives — the HTTP route reads it from here, so a transport change stays one
 * edit in one package.
 *
 * Both transports state 25 MB, but they count different bytes:
 *
 * - Direct: OpenAI caps an `/audio/transcriptions` upload at 25 MB of raw
 *   audio.
 * - Cloudflare: the same bytes travel base64 inside a JSON body, which is 4/3
 *   of the raw size. Cloudflare documents 25 MB as the largest request it
 *   caches and 10 MB as the largest it logs, so a 25 MB clip (about 33 MB
 *   encoded) leaves the documented envelope on this path.
 *
 * 18 MB of raw audio encodes to about 24 MB, which stays inside both. That is
 * still hours of Opus, and a composer dictation is seconds.
 */
export const MAX_TRANSCRIBE_AUDIO_BYTES = 18 * 1024 * 1024;

const TRANSCRIBE_TIMEOUT_MS = 300_000;

/**
 * Cloudflare's catalog name. `gpt-4o-mini-transcribe` is not in the catalog —
 * only the full `gpt-4o-transcribe` is — so the gateway path cannot use the
 * cheaper sibling the direct path uses.
 */
const CLOUDFLARE_MODEL = "openai/gpt-4o-transcribe";

/**
 * Cheaper than `whisper-1` with better punctuation on short conversational
 * clips, which is what composer dictation produces. Direct path only.
 */
const DIRECT_MODEL = "gpt-4o-mini-transcribe";

/** Cloudflare transport. Called by `Gateway.transcribe`, never chosen here. */
export async function transcribeViaCloudflareRun(
  gateway: GatewayConfig,
  audio: Uint8Array,
): Promise<TranscribeAudioResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/run`;
  const res = await fetch(url, {
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
  // The model's output schema is `{ text }` alone — no duration on this path.
  return { text, durationInSeconds: undefined };
}

/** Direct transport. Called by `Gateway.transcribe`, never chosen here. */
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

/**
 * The containers a browser recorder produces, as a closed set. Chrome records
 * WebM/Opus and Safari records MP4/AAC; the rest arrive when a user drops a
 * file into the composer.
 */
type AudioContainer = "wav" | "ogg" | "flac" | "mp4" | "mp3" | "webm";

/**
 * The subtype each container travels as inside the `data:` URI.
 *
 * These are a Cloudflare policy, not MIME facts. Cloudflare takes the subtype
 * verbatim as the filename extension it hands OpenAI, so each value must be a
 * name OpenAI accepts as an extension. `audio/mp4` and `audio/x-m4a` both fail
 * on an MP4/AAC clip that `audio/m4a` transcribes, which is why the MP4
 * container maps to `m4a`. Every value below returned 200 against
 * `openai/gpt-4o-transcribe`.
 *
 * A new container costs two typed edits: one member on `AudioContainer` and
 * one row here. A missing row does not compile.
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
 * Sniff the container from the byte signature, the way the AI SDK did before
 * this path left it — the browser's own `MediaRecorder.mimeType` carries codec
 * parameters (`audio/webm;codecs=opus`) and Safari lies by omission.
 *
 * This is the third hand-rolled signature table in the tree, after
 * `sniffBinaryType` (`fetch-url.ts`) and `sniffPassThroughImageMime`
 * (`attachments.ts`). They stay separate on purpose: each one returns a
 * different label set — a response MIME type there, a pass-through image MIME
 * there, a filename extension here — so a merge would only move the mapping
 * problem into a shared function.
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
    return "webm"; // EBML — WebM/Matroska, what Chrome records
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
