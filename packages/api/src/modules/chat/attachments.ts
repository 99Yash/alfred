import {
  classifyUpload,
  isPassThrough,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type IngestPolicyEntry,
} from "@alfred/contracts";
import type { chatAttachments } from "@alfred/db/schemas";
import { BadRequestError } from "../../middleware/errors";
import { buildAttachmentKey, headObject, readObjectPrefix } from "./storage";

/**
 * Shared validation + row construction for chat attachments (ADR-0065). Used by
 * the upload / turn HTTP endpoints so all durable write paths agree on the
 * policy and storage-key convention — and so the client never gets to choose
 * where its bytes live.
 */

/** A client-supplied attachment descriptor (the bytes are already uploaded). */
export interface AttachmentInput {
  id: string;
  name: string;
  mime: string;
  size: number;
  position: number;
}

const IMAGE_SNIFF_BYTES = 16;

function normalizedMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Minimal phase-1 image signature sniff. This is deliberately narrower than the
 * MIME whitelist: it proves the uploaded bytes are one of the pass-through image
 * formats before a row can become `ready` and enter the model transcript.
 */
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
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
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

export function assertPassThroughImageBytes(bytes: Uint8Array, declaredMime: string): void {
  const actualMime = sniffPassThroughImageMime(bytes);
  if (!actualMime) {
    throw new BadRequestError("File contents are not a supported image");
  }
  if (actualMime !== normalizedMime(declaredMime)) {
    throw new BadRequestError("File contents don't match the declared image type");
  }
}

/**
 * Validate an upload against the ingest policy. Phase 1 accepts only
 * `pass-through` images end to end; audio / pdf / docs / video gain support when
 * the degrade worker lands (Phase 2/3), at which point this gate relaxes.
 * Returns the matched policy entry so callers can enforce the per-type size cap
 * consistently at every upload boundary.
 */
export function assertUploadAllowed(mime: string, size: number): IngestPolicyEntry {
  const policy = classifyUpload(mime);
  if (!policy) {
    throw new BadRequestError(`Unsupported file type: ${mime || "unknown"}`);
  }
  if (!isPassThrough(mime)) {
    throw new BadRequestError(
      "Only image uploads are supported right now — other file types are coming soon.",
    );
  }
  if (size <= 0) throw new BadRequestError("File must not be empty");
  if (size > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));
    throw new BadRequestError(`File is too large — the limit is ${mb} MB`);
  }
  return policy;
}

export function assertAttachmentBatchAllowed(
  attachments: readonly Pick<AttachmentInput, "size">[],
): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new BadRequestError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
    throw new BadRequestError(`Attachments are too large — the combined limit is ${mb} MB`);
  }
}

/**
 * Build the durable `chat_attachments` insert row for one upload — validating
 * the policy and rebuilding the storage key server-side. Phase 1 images are
 * pass-through, so the row lands `ready` (no degrade). Insert with
 * `onConflictDoNothing` on the id so retries remain idempotent.
 */
export function toAttachmentRow(opts: {
  userId: string;
  threadId: string;
  messageId: string;
  attachment: AttachmentInput;
}): typeof chatAttachments.$inferInsert {
  const { userId, threadId, messageId, attachment } = opts;
  assertUploadAllowed(attachment.mime, attachment.size);
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
  };
}

/**
 * Prove that the object referenced by a would-be ready row actually exists and
 * is the image type the client declared. This closes both forged turn payloads
 * and the legacy signed-upload route: no object-store receipt, no ready row.
 */
export async function assertStoredAttachmentReady(opts: {
  storageKey: string;
  mime: string;
  size: number;
}): Promise<void> {
  let meta: { size: number; contentType: string };
  let prefix: Uint8Array;
  try {
    meta = await headObject(opts.storageKey);
    prefix = await readObjectPrefix(opts.storageKey, IMAGE_SNIFF_BYTES);
  } catch {
    throw new BadRequestError("Attachment upload is missing or incomplete");
  }
  if (meta.size !== opts.size) {
    throw new BadRequestError("Attachment upload size doesn't match the sent message");
  }
  const storedMime = normalizedMime(meta.contentType);
  const declaredMime = normalizedMime(opts.mime);
  if (storedMime && storedMime !== declaredMime) {
    throw new BadRequestError("Stored attachment type doesn't match the sent message");
  }
  assertPassThroughImageBytes(prefix, opts.mime);
}
