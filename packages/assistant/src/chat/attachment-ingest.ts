import { Errors, isApiError, isPdfContentType, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

import { enqueuePendingUploadCleanup } from "@alfred/assistant/connections/ingestion";
import { createPdfExtractor, formatExtractedPdfText, type ExtractedPdf } from "@alfred/extraction";
import {
  assertPassThroughImageBytes,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  attachmentUrl,
  buildAttachmentKey,
  isStorageConfigured,
  objectExists,
  readObject,
  writeObject,
} from "./attachments";
import {
  assertAttachmentUploadBudgetAllowed,
  assertAttachmentUploadRateAllowed,
  releasePendingUploadBudget,
} from "./attachment-upload-quota";

/**
 * Attachment ingest for the chat composer (ADR-0065). Owns what happens to the
 * bytes: the quota reservation, the duplicate short circuit, the pass-through
 * image decode, the write to the bucket, and the auth-scoped read back.
 *
 * The transport in front of this decodes a multipart request and turns a throw
 * into a status. It takes no decision that outlives the response.
 */

/** PDF extraction limits for chat uploads — bounded by the ingest policy's 10 MB cap. */
const PDF_EXTRACTION_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxCharacters: 100_000,
  maxParseMilliseconds: 30_000,
} as const;

/**
 * Extract chat-safe text from PDF bytes. A scanned PDF can continue without
 * deterministic text. Invalid, encrypted, and resource-limited PDFs fail at
 * the ingest boundary instead of creating a ready row with no readable data.
 */
export async function extractChatPdfText(bytes: Uint8Array): Promise<string | null> {
  const extractPdf = createPdfExtractor(PDF_EXTRACTION_LIMITS);
  let result: ExtractedPdf;
  try {
    result = await extractPdf(bytes);
  } catch (err) {
    console.warn("[chat] PDF extraction failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't read the PDF. Try again.");
  }

  const text = formatExtractedPdfText(result);
  if (text !== null) return text;

  switch (result.kind) {
    case "needs_ocr":
      return null;
    case "encrypted":
      throw Errors.BadRequestError("This PDF is encrypted and can't be read");
    case "invalid":
      throw Errors.BadRequestError(`This PDF is invalid: ${result.reason}`);
    case "limit_exceeded":
      throw Errors.BadRequestError(`PDF extraction exceeded the limit: ${result.message}`);
    case "extracted":
    case "text_without_pages":
      return null;
  }
}

/**
 * The upload and send are separate requests. This short cache avoids a second
 * extraction in the normal path. The raw object is the durable fallback, so a
 * process restart or an expired entry does not lose the PDF text.
 */
const PENDING_PDF_TEXT_TTL_MS = 5 * 60 * 1_000;
interface PendingPdfText {
  degradedText: string | null;
  expiresAt: number;
  evictionTimer: ReturnType<typeof setTimeout>;
}
const pendingPdfDegradedText = new Map<string, PendingPdfText>();

/** Prevent two local requests from writing different bytes under one storage key. */
const inFlightAttachmentUploads = new Set<string>();

export function rememberPendingPdfDegradedText(
  storageKey: string,
  degradedText: string | null,
): void {
  const previous = pendingPdfDegradedText.get(storageKey);
  if (previous) clearTimeout(previous.evictionTimer);

  const entry: PendingPdfText = {
    degradedText,
    expiresAt: Date.now() + PENDING_PDF_TEXT_TTL_MS,
    evictionTimer: setTimeout(() => {
      if (pendingPdfDegradedText.get(storageKey) === entry) {
        pendingPdfDegradedText.delete(storageKey);
      }
    }, PENDING_PDF_TEXT_TTL_MS),
  };
  entry.evictionTimer.unref?.();
  pendingPdfDegradedText.set(storageKey, entry);
}

/**
 * Retrieve and consume the cached degraded text for a PDF attachment.
 * `null` records a known OCR-only PDF; `undefined` means there is no live entry.
 */
export function consumePendingPdfDegradedText(storageKey: string): string | null | undefined {
  const entry = pendingPdfDegradedText.get(storageKey);
  if (!entry) return undefined;

  clearTimeout(entry.evictionTimer);
  pendingPdfDegradedText.delete(storageKey);
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry.degradedText;
}

/**
 * Consume the upload-time result, or recover it from durable raw bytes after a
 * restart or cache expiry. A known OCR-only result produces no degraded text.
 */
export async function consumeOrRecoverPdfDegradedText(opts: {
  storageKey: string;
  mime: string;
}): Promise<string | undefined> {
  if (!isPdfContentType(opts.mime)) return undefined;
  const pending = consumePendingPdfDegradedText(opts.storageKey);
  if (pending !== undefined) return pending ?? undefined;

  let bytes: Uint8Array;
  try {
    bytes = await readObject(opts.storageKey);
  } catch (err) {
    console.warn("[chat] PDF recovery read failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't read the uploaded PDF. Try again.");
  }
  return (await extractChatPdfText(bytes)) ?? undefined;
}

/** A fresh upload the composer has sent to the server. */
export interface UploadChatAttachmentInput {
  userId: string;
  threadId: string;
  messageId: string;
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
  /**
   * The bytes, read on demand. A thunk, not a `Uint8Array`, because the two
   * short circuits above it (a duplicate row, an object already at this key)
   * answer without reading the body at all — an eager parameter would read
   * bytes this path never reads. A `File` would do the same job, but a Web
   * `File` is a transport shape and does not belong in a product signature.
   */
  readBytes: () => Promise<Uint8Array>;
}

export async function schedulePendingUploadCleanup(
  userId: string,
  storageKey: string,
): Promise<void> {
  try {
    await enqueuePendingUploadCleanup(userId, storageKey);
  } catch (err) {
    console.warn("[chat] pending upload cleanup enqueue failed:", toMessage(err));
  }
}

/**
 * Accept one attachment's bytes into the bucket and return the key the send
 * step will reference. No `chat_attachments` row is written here — that happens
 * at send time, in {@link import("./turn-admission").startChatTurn}.
 *
 * The reserve/release accounting is the delicate part. `reservedPendingBytes`
 * becomes non-zero only AFTER the byte checks pass and only BEFORE the write,
 * so the `catch` releases exactly what was reserved and releases nothing when an
 * earlier step throws.
 */
export async function uploadChatAttachment(
  input: UploadChatAttachmentInput,
): Promise<{ storageKey: string }> {
  if (!isStorageConfigured()) {
    throw Errors.ServiceUnavailableError(
      "File uploads aren't configured — set the CHAT_S3_* env vars on the server.",
    );
  }
  // Validate the declared mime + actual byte size against the ingest
  // policy (per-type cap); the storage key is rebuilt server-side.
  assertUploadAllowed(input.mime, input.size);
  const storageKey = buildAttachmentKey({
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    fileName: input.name,
  });
  if (inFlightAttachmentUploads.has(storageKey)) {
    throw Errors.ConflictError("Attachment upload is already in progress");
  }
  inFlightAttachmentUploads.add(storageKey);
  let reservedPendingBytes = 0;
  try {
    await assertAttachmentUploadRateAllowed(input.userId);
    const existingRows = await db()
      .select({ id: chatAttachments.id })
      .from(chatAttachments)
      .where(eq(chatAttachments.id, input.attachmentId))
      .limit(1);
    if (existingRows[0]) {
      throw Errors.ConflictError("Attachment already exists");
    }
    if (await objectExists(storageKey)) {
      await assertStoredAttachmentReady({
        storageKey,
        mime: input.mime,
        size: input.size,
      });
      await schedulePendingUploadCleanup(input.userId, storageKey);
      return { storageKey };
    }
    const bytes = await input.readBytes();

    // Extract PDFs before the common storage tail. Images keep their existing
    // pass-through decode. No other degrade-text type is admitted by the gate.
    const isPdf = isPdfContentType(input.mime);
    let degradedText: string | null | undefined;
    if (isPdf) {
      degradedText = await extractChatPdfText(bytes);
    } else {
      await assertPassThroughImageBytes(bytes, input.mime);
    }

    await assertAttachmentUploadBudgetAllowed({
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.messageId,
      size: input.size,
    });
    reservedPendingBytes = input.size;
    await writeObject(storageKey, bytes, input.mime);
    if (isPdf) {
      rememberPendingPdfDegradedText(storageKey, degradedText ?? null);
    }
    await schedulePendingUploadCleanup(input.userId, storageKey);
    return { storageKey };
  } catch (err) {
    await releasePendingUploadBudget(input.userId, reservedPendingBytes);
    if (isApiError(err, "BAD_REQUEST", "CONFLICT", "TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"))
      throw err;
    console.error("[chat] proxied upload failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't store the upload. Try again.");
  } finally {
    inFlightAttachmentUploads.delete(storageKey);
  }
}

/**
 * A freshly minted presigned GET for one of this user's attachments. The bucket
 * is private, so the synced row carries display metadata only and the raw bytes
 * are reachable only through an owner-scoped lookup. Throws when the attachment
 * is not this user's, which is what makes the redirect safe to hand to an
 * `<img>` tag.
 */
export async function resolveChatAttachmentContentUrl(
  attachmentId: string,
  userId: string,
): Promise<string> {
  const rows = await db()
    .select({ storageKey: chatAttachments.storageKey })
    .from(chatAttachments)
    .where(and(eq(chatAttachments.id, attachmentId), eq(chatAttachments.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw Errors.NotFoundError("Attachment not found");
  if (!isStorageConfigured()) {
    throw Errors.ServiceUnavailableError("File storage isn't configured");
  }
  return await attachmentUrl(row.storageKey);
}
