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
 * A fully-formed chat attachment descriptor: the shape the client hands to the
 * turn after a successful upload, and the shape the server's write helpers
 * consume. `position` is the attachment's index within its message. Both sides
 * must agree on this, so it lives here (the web app aliases it as
 * `UploadedAttachment`, the API as `AttachmentInput`).
 */
export interface ChatAttachmentDescriptor {
  id: string;
  name: string;
  mime: string;
  size: number;
  position: number;
}

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
 * Per-image encoded payload budget for Phase 1 pass-through images. Chat's
 * primary provider is Claude, whose direct API caps base64 image blocks at
 * 10 MB; keep our raw upload cap below that after base64 expansion so accepted
 * uploads do not depend on fallback routing.
 */
export const MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE = 9 * MB;

/** Largest raw image that fits under the per-image encoded payload budget. */
export const MAX_ATTACHMENT_BYTES_PER_FILE = Math.floor(
  (MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE * 3) / 4,
);

/**
 * MIME → ingest policy. The whitelist *is* the keys of this map — anything not
 * listed is `reject`ed at the boundary (see {@link classifyUpload}).
 *
 * Note on images: pass-through means readable by both the primary Claude chat
 * models and the Gemini reliability fallback. GIF is Claude-readable but not a
 * Gemini image input type, so it waits for the Phase 2/3 transcode path rather
 * than being accepted as raw pass-through. HEIC/HEIF likewise need transcode.
 */
export const INGEST_POLICY: Readonly<Record<string, IngestPolicyEntry>> = {
  // Images — pass-through (the universal modality).
  "image/jpeg": { kind: "pass-through", maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE },
  "image/png": { kind: "pass-through", maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE },
  "image/webp": { kind: "pass-through", maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE },
  // Image formats that need transcode at ingest.
  "image/gif": { kind: "degrade-av", maxBytes: 15 * MB },
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
 * Maximum encoded attachment payload bytes inlined into one model request. The
 * transcript builder prioritizes newer images and replaces older overflow images
 * with text placeholders, keeping historical threads from replaying unbounded
 * media. This stays below Gemini's 20 MB inline request ceiling to leave space
 * for system text, tools, and JSON framing.
 */
export const MAX_MODEL_ATTACHMENT_BYTES_PER_TURN = 16 * MB;

/**
 * Aggregate raw-byte cap for one chat message's attachments. The model path
 * base64-inlines every ready image, so this is capped at the largest raw payload
 * that fits inside {@link MAX_MODEL_ATTACHMENT_BYTES_PER_TURN} after expansion.
 */
export const MAX_ATTACHMENT_BYTES_PER_MESSAGE = Math.floor(
  (MAX_MODEL_ATTACHMENT_BYTES_PER_TURN * 3) / 4,
);

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
