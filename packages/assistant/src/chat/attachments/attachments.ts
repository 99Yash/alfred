import { Buffer } from "node:buffer";
import {
  type ChatAttachmentDescriptor,
  classifyUpload,
  Errors,
  isApiError,
  isChatUploadAllowed,
  isPdfContentType,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  normalizeMimeType,
  type IngestPolicyEntry,
} from "@alfred/contracts";
import type { NewChatAttachment } from "@alfred/db/schemas";
import sharp from "sharp";
import { buildAttachmentKey, headObject } from "./storage";

/** Chat attachment validation and rows (ADR-0065). The server builds the key; the client never picks it. */

/** What the model can read. PDF `text: null` means OCR is needed; images never carry it. */
export type AttachmentDegradation = { kind: "image" } | { kind: "pdf"; text: string | null };

const MIN_MODEL_IMAGE_EDGE_PX = 64;

// Anthropic rejects a longest edge over 8000px; an accepted upload must not need the fallback.
const MAX_MODEL_IMAGE_EDGE_PX = 8_000;

const MAX_MODEL_IMAGE_PIXELS = 40_000_000;

function normalizedMime(mime: string): string {
  return normalizeMimeType(mime);
}

/** Prove the bytes are a pass-through image format, not just the declared MIME. */
export function sniffPassThroughImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

function sharpFormatToMime(format: string | undefined): string | null {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export async function assertPassThroughImageBytes(
  bytes: Uint8Array,
  declaredMime: string,
): Promise<void> {
  const actualMime = sniffPassThroughImageMime(bytes);

  if (!actualMime) {
    throw Errors.BadRequestError("File contents are not a supported image");
  }

  if (actualMime !== normalizedMime(declaredMime)) {
    throw Errors.BadRequestError("File contents don't match the declared image type");
  }

  try {
    const input = Buffer.from(bytes);

    const metadata = await sharp(input, {
      failOn: "error",
      limitInputPixels: MAX_MODEL_IMAGE_PIXELS,
    }).metadata();

    const decodedMime = sharpFormatToMime(metadata.format);

    if (!decodedMime) {
      throw Errors.BadRequestError("File contents are not a supported image");
    }

    if (decodedMime !== normalizedMime(declaredMime)) {
      throw Errors.BadRequestError("File contents don't match the declared image type");
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width < MIN_MODEL_IMAGE_EDGE_PX || height < MIN_MODEL_IMAGE_EDGE_PX) {
      throw Errors.BadRequestError("Image is too small to attach");
    }

    if (width > MAX_MODEL_IMAGE_EDGE_PX || height > MAX_MODEL_IMAGE_EDGE_PX) {
      throw Errors.BadRequestError("Image dimensions are too large");
    }

    // Force libvips to decode pixels, not just parse container metadata.
    await sharp(input, {
      failOn: "error",
      limitInputPixels: MAX_MODEL_IMAGE_PIXELS,
    })
      .resize({ width: 1, height: 1, fit: "inside" })
      .toBuffer();
  } catch (err) {
    if (isApiError(err, "BAD_REQUEST")) throw err;
    throw Errors.BadRequestError("Image could not be decoded");
  }
}

/** Check an upload against the ingest policy and its per-type size cap. Returns the policy entry. */
export function assertUploadAllowed(mime: string, size: number): IngestPolicyEntry {
  const policy = classifyUpload(mime);

  if (!policy) {
    throw Errors.BadRequestError(`Unsupported file type: ${mime || "unknown"}`);
  }

  if (!isChatUploadAllowed(mime)) {
    throw Errors.BadRequestError(
      "Only images and PDFs are supported right now — other file types are coming soon.",
    );
  }

  if (size <= 0) throw Errors.BadRequestError("File must not be empty");

  if (size > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));
    throw Errors.BadRequestError(`File is too large — the limit is ${mb} MB`);
  }

  return policy;
}

export function assertAttachmentBatchAllowed(
  attachments: readonly Pick<ChatAttachmentDescriptor, "size">[],
): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw Errors.BadRequestError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
  }

  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);

  if (totalBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
    throw Errors.BadRequestError(`Attachments are too large — the combined limit is ${mb} MB`);
  }
}

/** Build the `chat_attachments` row and rebuild its key. Insert with `onConflictDoNothing` for retries. */
export function toAttachmentRow(opts: {
  userId: string;
  threadId: string;
  messageId: string;
  attachment: ChatAttachmentDescriptor;
  degradation: AttachmentDegradation;
}): NewChatAttachment {
  const { userId, threadId, messageId, attachment, degradation } = opts;
  assertUploadAllowed(attachment.mime, attachment.size);

  if (isPdfContentType(attachment.mime) !== (degradation.kind === "pdf")) {
    throw Errors.BadRequestError("Attachment content state doesn't match its file type");
  }

  return {
    id: attachment.id,
    userId,
    messageId,
    storageKey: buildAttachmentKey({
      userId,
      threadId,
      messageId,
      attachmentId: attachment.id,
      fileName: attachment.name,
    }),
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    position: attachment.position,
    status: "ready",
    ...(degradation.kind === "pdf" ? { degradedText: degradation.text } : {}),
  };
}

/** Prove a retry sends the exact stored bytes. Size and MIME can match for different payloads. */
export function assertStoredAttachmentBytesMatch(opts: {
  storedBytes: Uint8Array;
  candidateBytes: Uint8Array;
}): void {
  if (!Buffer.from(opts.storedBytes).equals(opts.candidateBytes)) {
    throw Errors.ConflictError("Attachment storage key already belongs to different bytes");
  }
}

/** Stored metadata must match the declared payload. A blank content-type passes: some providers omit it on HEAD. */
export function validateStoredMeta(opts: {
  stored: { size: number; contentType: string };
  declared: { mime: string; size: number };
}): void {
  if (opts.stored.size !== opts.declared.size) {
    throw Errors.BadRequestError("Attachment upload size doesn't match the sent message");
  }

  const storedMime = normalizedMime(opts.stored.contentType);
  const declaredMime = normalizedMime(opts.declared.mime);

  if (storedMime && storedMime !== declaredMime) {
    throw Errors.BadRequestError("Stored attachment type doesn't match the sent message");
  }
}

/**
 * Block forged turn payloads: a row is `ready` only if its key holds an object of
 * the declared size and type. Only a HEAD: the upload route already validated the bytes.
 */
export async function assertStoredAttachmentReady(opts: {
  storageKey: string;
  mime: string;
  size: number;
}): Promise<void> {
  let meta: { size: number; contentType: string };

  try {
    meta = await headObject(opts.storageKey);
  } catch {
    throw Errors.BadRequestError("Attachment upload is missing or incomplete");
  }

  validateStoredMeta({ stored: meta, declared: { mime: opts.mime, size: opts.size } });
}
