import { z } from "zod";
import { normalizeMimeType } from "./mime";

/**
 * Chat upload policy (ADR-0065), shared by the composer and the degrade worker.
 * The model only receives text and images: every other type becomes text at ingest.
 */

/** Only `ready` attachments enter the transcript. `failed` ones are shown, never sent. */
export const chatAttachmentStatusValues = ["pending", "ready", "failed"] as const;

export type ChatAttachmentStatus = (typeof chatAttachmentStatusValues)[number];

export const chatAttachmentStatusSchema = z.enum(chatAttachmentStatusValues);

/** An uploaded attachment as the client sends it with a turn. `position` is its index in the message. */
export interface ChatAttachmentDescriptor {
  id: string;
  name: string;
  mime: string;
  size: number;
  position: number;
}

/**
 * How an upload becomes text and images (ADR-0065). `degrade-av` splits video into
 * a transcript and keyframes, or transcodes an image the model cannot read.
 */
export const ingestKindValues = ["pass-through", "degrade-text", "degrade-av", "reject"] as const;

export type IngestKind = (typeof ingestKindValues)[number];

/** The text extractor for a `degrade-text` type. */
export const contentFormatValues = ["pdf", "document", "spreadsheet", "text"] as const;

export const contentFormatSchema = z.enum(contentFormatValues);

export type ContentFormat = z.infer<typeof contentFormatSchema>;

export interface IngestPolicyEntry {
  kind: Exclude<IngestKind, "reject">;
  /** Per-file cap. */
  maxBytes: number;
  contentFormat?: ContentFormat;
}

const MB = 1024 * 1024;

/** Base64 budget per image, under a 10 MB provider image cap. */
export const MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE = 9 * MB;

/** The largest raw image that fits the budget after base64. */
export const MAX_ATTACHMENT_BYTES_PER_FILE = Math.floor(
  (MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE * 3) / 4,
);

/**
 * The keys are the whitelist. Pass-through images must work on every chat model leg:
 * Gemini rejects GIF, so GIF (and HEIC/HEIF) need a transcode.
 */
export const INGEST_POLICY = {
  "image/jpeg": {
    kind: "pass-through",
    maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE,
  },
  "image/png": {
    kind: "pass-through",
    maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE,
  },
  "image/webp": {
    kind: "pass-through",
    maxBytes: MAX_ATTACHMENT_BYTES_PER_FILE,
  },
  "image/gif": { kind: "degrade-av", maxBytes: 15 * MB },
  "image/heic": { kind: "degrade-av", maxBytes: 15 * MB },
  "image/heif": { kind: "degrade-av", maxBytes: 15 * MB },

  "audio/mpeg": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/mp4": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/wav": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/x-wav": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/webm": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/ogg": { kind: "degrade-text", maxBytes: 15 * MB },
  "audio/aac": { kind: "degrade-text", maxBytes: 15 * MB },

  "video/mp4": { kind: "degrade-av", maxBytes: 15 * MB },
  "video/webm": { kind: "degrade-av", maxBytes: 15 * MB },
  "video/quicktime": { kind: "degrade-av", maxBytes: 15 * MB },

  "application/pdf": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
    contentFormat: "pdf",
  },
  "application/x-pdf": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
    contentFormat: "pdf",
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
    contentFormat: "document",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "degrade-text",
    maxBytes: 10 * MB,
    contentFormat: "spreadsheet",
  },
  "text/plain": { kind: "degrade-text", maxBytes: 10 * MB, contentFormat: "text" },
  "text/markdown": { kind: "degrade-text", maxBytes: 10 * MB, contentFormat: "text" },
  "text/csv": { kind: "degrade-text", maxBytes: 10 * MB, contentFormat: "text" },
} as const satisfies Readonly<Record<string, IngestPolicyEntry>>;

const ingestPolicyByMime: Readonly<Record<string, IngestPolicyEntry>> = INGEST_POLICY;

/** Types whose full chat ingest path works today. */
const CHAT_UPLOAD_ALLOWED_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/x-pdf",
] satisfies readonly (keyof typeof INGEST_POLICY)[]);

export const SUPPORTED_FILE_TYPES = Object.keys(INGEST_POLICY);

export function isPdfContentType(mime: string): boolean {
  const normalized = normalizeMimeType(mime);

  return classifyUpload(normalized)?.contentFormat === "pdf";
}

export function getContentFormat(mime: string): ContentFormat | null {
  const normalized = normalizeMimeType(mime);

  return classifyUpload(normalized)?.contentFormat ?? null;
}

/** Every write path enforces this (ADR-0065). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Encoded image bytes inlined into one model request. Older images past it become
 * text placeholders. Below Gemini's 20 MB request cap, to leave room for the prompt.
 */
export const MAX_MODEL_ATTACHMENT_BYTES_PER_TURN = 16 * MB;

/** Raw bytes per message that fit {@link MAX_MODEL_ATTACHMENT_BYTES_PER_TURN} after base64. */
export const MAX_ATTACHMENT_BYTES_PER_MESSAGE = Math.floor(
  (MAX_MODEL_ATTACHMENT_BYTES_PER_TURN * 3) / 4,
);

/** A coarse pre-check. The per-type cap still applies. */
export const MAX_ATTACHMENT_BYTES = Math.max(
  ...Object.values(INGEST_POLICY).map((e) => e.maxBytes),
);

/** `null` outside the whitelist. Ignores case and a `; charset=` suffix. */
export function classifyUpload(mime: string): IngestPolicyEntry | null {
  const normalized = normalizeMimeType(mime);

  return ingestPolicyByMime[normalized] ?? null;
}

export function isChatUploadAllowed(mime: string): boolean {
  const normalized = normalizeMimeType(mime);

  return CHAT_UPLOAD_ALLOWED_TYPES.has(normalized);
}

/** A model-readable image that needs no degrade. */
export function isPassThrough(mime: string): boolean {
  return classifyUpload(mime)?.kind === "pass-through";
}
