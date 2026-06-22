import { z } from "zod";

/**
 * Chat file uploads (ADR-0065). The load-bearing invariant: the boss model only
 * ever receives **text and images**. Every non-universal modality (audio, video,
 * pdf, docs, code) is *degraded* to text (+ optional keyframe images) at ingest,
 * so the transcript never holds a part a model can't read. This module is the
 * pure, web-safe source of truth for **what is accepted and how it's normalized**
 * — shared by the composer (client-side validation) and the degrade worker
 * (server-side normalization) so the two can never disagree. Zero Node deps.
 */

/**
 * Async lifecycle of an uploaded attachment.
 *   - `pending` — row created, bytes may still be uploading / degrading.
 *   - `ready`   — degraded artifact written; safe to fold into the transcript.
 *   - `failed`  — degrade rejected or errored; surfaced to the user, never sent.
 */
export const chatAttachmentStatusValues = ["pending", "ready", "failed"] as const;
export type ChatAttachmentStatus = (typeof chatAttachmentStatusValues)[number];
export const chatAttachmentStatusSchema = z.enum(chatAttachmentStatusValues);

/**
 * How an upload is normalized for the model. This *replaces* the rejected
 * `MODEL_CAPABILITIES` idea (ADR-0065): the question is never "which model reads
 * this" but "how is this turned into text + images."
 *   - `pass-through` — universally-supported image; enters the transcript as-is.
 *   - `degrade-text` — extract/transcribe to text (audio, pdf, docs, code).
 *   - `degrade-av`   — split audio→transcript + keyframes→images (video), or
 *                      transcode an image format the model can't read (heic).
 *   - `reject`       — refused at the boundary with a clear message.
 */
export const ingestKindValues = ["pass-through", "degrade-text", "degrade-av", "reject"] as const;
export type IngestKind = (typeof ingestKindValues)[number];

export interface IngestPolicyEntry {
  /** How this MIME type is normalized for the model. */
  kind: Exclude<IngestKind, "reject">;
  /** Per-file upload cap, in bytes. Single-user caps (ADR-0065) — modest. */
  maxBytes: number;
}

const MB = 1024 * 1024;

/**
 * MIME → ingest policy. The whitelist *is* the keys of this map — anything not
 * listed is `reject`ed at the boundary (see {@link classifyUpload}).
 *
 * Note on images: the boss models (Anthropic) read only jpeg/png/gif/webp, so
 * those are the only true `pass-through` types. HEIC is an image MIME but is not
 * model-readable, so it is `degrade-av` (transcode to jpeg) — handled by the
 * ffmpeg path, not Phase 1.
 */
export const INGEST_POLICY: Readonly<Record<string, IngestPolicyEntry>> = {
  // Images — pass-through (the universal modality).
  "image/jpeg": { kind: "pass-through", maxBytes: 15 * MB },
  "image/png": { kind: "pass-through", maxBytes: 15 * MB },
  "image/webp": { kind: "pass-through", maxBytes: 15 * MB },
  "image/gif": { kind: "pass-through", maxBytes: 15 * MB },
  // Image format the model can't read — transcode to jpeg at ingest.
  "image/heic": { kind: "degrade-av", maxBytes: 15 * MB },
  "image/heif": { kind: "degrade-av", maxBytes: 15 * MB },

  // Audio — transcribe to text.
  "audio/mpeg": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/mp4": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/wav": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/x-wav": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/webm": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/ogg": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/aac": { kind: "degrade-text", maxBytes: 15 * MB },

  // Video — split audio→transcript + keyframes→images.
  "video/mp4": { kind: "degrade-av", maxBytes: 15 * MB },
  "video/webm": { kind: "degrade-av", maxBytes: 15 * MB },
  "video/quicktime": { kind: "degrade-av", maxBytes: 15 * MB },

  // Documents & code — extract text.
  "application/pdf": { kind: "degrade-text", maxBytes: 10 * MB },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
  },
  "text/plain": { kind: "degrade-text", maxBytes: 10 * MB },
  "text/markdown": { kind: "degrade-text", maxBytes: 10 * MB },
  "text/csv": { kind: "degrade-text", maxBytes: 10 * MB },
} as const;

/** Every MIME type the upload boundary accepts (the whitelist). */
export const SUPPORTED_FILE_TYPES = Object.keys(INGEST_POLICY);

/**
 * Max files attachable to a single chat message (ADR-0065). Single source of
 * truth shared by the composer (stage-time cap), the turn endpoint, and the
 * Replicache server mutator so every write path agrees — no path can be the one
 * that lets an unbounded count through.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Largest cap across all supported types — a coarse pre-check / server guard.
 * Per-type enforcement still happens against the matched {@link IngestPolicyEntry}.
 */
export const MAX_ATTACHMENT_BYTES = Math.max(
  ...Object.values(INGEST_POLICY).map((e) => e.maxBytes),
);

/**
 * Resolve an upload's policy from its MIME type. Returns `null` for anything
 * outside the whitelist — the caller rejects with a clear message. MIME is
 * lower-cased and stripped of any `; charset=…` suffix before lookup.
 */
export function classifyUpload(mime: string): IngestPolicyEntry | null {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return INGEST_POLICY[normalized] ?? null;
}

/**
 * True when the upload is a model-readable image that needs no degrade — the
 * only modality Phase 1 (ADR-0065) supports end to end.
 */
export function isPassThrough(mime: string): boolean {
  return classifyUpload(mime)?.kind === "pass-through";
}

/**
 * One attachment as the composer and status poller see it. Mirrors the durable
 * `chat_attachments` row, minus server-only fields (the raw storage key and the
 * degraded artifact never cross to the client).
 */
export interface ChatAttachmentView {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  size: number;
  position: number;
  status: ChatAttachmentStatus;
}

export const chatAttachmentViewSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  position: z.number().int().nonnegative(),
  status: chatAttachmentStatusSchema,
});
