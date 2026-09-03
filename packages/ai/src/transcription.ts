import { getStringPath, httpErrorFromResponse } from "@alfred/contracts";
import { cloudflareGatewayConfig } from "@alfred/env/server";
import { transcribe } from "ai";

import { createGateway, type GatewayConfig } from "./gateway";

/**
 * Speech-to-text for the chat composer's voice input.
 *
 * Two transports, because Cloudflare attaches a Unified Billing credential
 * per *endpoint*, not per gateway:
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
 * Callers gate on `cloudflareGatewayEnabled() || OPENAI_API_KEY` and surface a
 * friendly error when neither is present.
 */
export interface TranscribeAudioResult {
  text: string;
  /** Clip length as reported by the provider; undefined when not returned. */
  durationInSeconds: number | undefined;
}

const TRANSCRIBE_TIMEOUT_MS = 300_000;

/**
 * Cloudflare's catalog name. `gpt-4o-mini-transcribe` is not in the catalog —
 * only the full `gpt-4o-transcribe` is — so the gateway path cannot use the
 * cheaper sibling the direct path uses.
 */
const GATEWAY_MODEL = "openai/gpt-4o-transcribe";

/**
 * Cheaper than `whisper-1` with better punctuation on short conversational
 * clips, which is what composer dictation produces. Direct path only.
 */
const DIRECT_MODEL = "gpt-4o-mini-transcribe";

export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  const gateway = cloudflareGatewayConfig();
  return gateway ? transcribeViaCloudflare(gateway, audio) : transcribeDirect(audio);
}

async function transcribeViaCloudflare(
  gateway: GatewayConfig,
  audio: Uint8Array,
): Promise<TranscribeAudioResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/run`;
  const file = `data:${audioMimeType(audio)};base64,${Buffer.from(audio).toString("base64")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      "cf-aig-gateway-id": gateway.gatewayId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GATEWAY_MODEL, input: { file } }),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) throw await httpErrorFromResponse("cloudflare-ai-run", res, { url, method: "POST" });

  const payload: unknown = await res.json();
  const text = getStringPath(payload, "result", "result", "text");
  if (text === undefined) throw new Error("Cloudflare /ai/run returned no transcript");
  // The model's output schema is `{ text }` alone — no duration on this path.
  return { text, durationInSeconds: undefined };
}

async function transcribeDirect(audio: Uint8Array): Promise<TranscribeAudioResult> {
  const openai = createGateway(undefined).createOpenAI();
  const result = await transcribe({
    model: openai.transcription(DIRECT_MODEL),
    audio,
    abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  return { text: result.text, durationInSeconds: result.durationInSeconds };
}

/**
 * Sniff the container from the byte signature, the way the AI SDK did before
 * this path left it — the browser's own `MediaRecorder.mimeType` carries codec
 * parameters (`audio/webm;codecs=opus`) and Safari lies by omission.
 *
 * The returned subtype is not cosmetic: Cloudflare uses it verbatim as the
 * filename extension it hands OpenAI, so it must be a name OpenAI accepts.
 * `audio/mp4` and `audio/x-m4a` both fail on an MP4/AAC clip that `audio/m4a`
 * transcribes, which is why Safari's recording maps to `m4a`. Every label
 * below returned 200 against `openai/gpt-4o-transcribe`.
 */
function audioMimeType(audio: Uint8Array): string {
  const at = (offset: number, text: string): boolean =>
    [...text].every((char, i) => audio[offset + i] === char.charCodeAt(0));

  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "fLaC")) return "audio/flac";
  if (at(4, "ftyp")) return "audio/m4a";
  if (at(0, "ID3")) return "audio/mp3";
  if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) {
    return "audio/webm"; // EBML — WebM/Matroska, what Chrome records
  }
  // MPEG audio frame sync (a bare MP3 with no ID3 tag).
  if (audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0) return "audio/mp3";

  // Chrome is the common recorder, so its container is the safest guess.
  return "audio/webm";
}
