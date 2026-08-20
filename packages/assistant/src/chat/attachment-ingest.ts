import { Errors, isApiError, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

import { enqueuePendingUploadCleanup } from "@alfred/assistant/connections/ingestion";
import { createPdfExtractor, type ExtractedPdf } from "@alfred/extraction";
import {
  assertPassThroughImageBytes,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  attachmentUrl,
  buildAttachmentKey,
  isStorageConfigured,
  objectExists,
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
 * Format extracted PDF text with page markers for citation. Uses per-page
 * markdown when available, falls back to the document-level text field.
 */
function formatPdfText(result: ExtractedPdf): string | null {
  if (result.kind === "extracted" && result.pages.length > 0) {
    return result.pages
      .map((page) => `[page ${page.pageNumber}]\n${page.markdown}`)
      .join("\n\n");
  }
  if (result.kind === "extracted" || result.kind === "text_without_pages") {
    return result.text;
  }
  return null;
}

/**
 * Extract text from PDF bytes. Returns the extracted text with page markers,
 * or null if extraction fails (encrypted, needs OCR, invalid, etc.).
 */
async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  const extractPdf = createPdfExtractor(PDF_EXTRACTION_LIMITS);
  let result: ExtractedPdf;
  try {
    result = await extractPdf(bytes);
  } catch {
    return null;
  }
  return formatPdfText(result);
}

/**
 * Ephemeral cache for PDF degraded text between upload and send. Keyed by
 * attachment ID. Populated during `uploadChatAttachment`, consumed during
 * `startChatTurn` when the row is written. Cleared after use.
 */
const pendingPdfDegradedText = new Map<string, string>();

/**
 * Retrieve and consume the cached degraded text for a PDF attachment.
 * Returns the text if present, or undefined if not (non-PDF or extraction failed).
 */
export function consumePendingPdfDegradedText(attachmentId: string): string | undefined {
  const text = pendingPdfDegradedText.get(attachmentId);
  if (text !== undefined) {
    pendingPdfDegradedText.delete(attachmentId);
  }
  return text;
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
): Promise<{ storageKey: string; degradedText?: string }> {
  if (!isStorageConfigured()) {
    throw Errors.ServiceUnavailableError(
      "File uploads aren't configured — set the CHAT_S3_* env vars on the server.",
    );
  }
  // Validate the declared mime + actual byte size against the ingest
  // policy (per-type cap); the storage key is rebuilt server-side.
  const policy = assertUploadAllowed(input.mime, input.size);
  const storageKey = buildAttachmentKey({
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    fileName: input.name,
  });
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

    // PDFs are extracted to text at upload time; images use the pass-through decode.
    if (policy.kind === "degrade-text" && input.mime === "application/pdf") {
      const degradedText = await extractPdfText(bytes);
      if (degradedText) {
        pendingPdfDegradedText.set(input.attachmentId, degradedText);
      }
      await assertAttachmentUploadBudgetAllowed({
        userId: input.userId,
        threadId: input.threadId,
        messageId: input.messageId,
        size: input.size,
      });
      reservedPendingBytes = input.size;
      await writeObject(storageKey, bytes, input.mime);
      await schedulePendingUploadCleanup(input.userId, storageKey);
      return { storageKey };
    }

    await assertPassThroughImageBytes(bytes, input.mime);
    await assertAttachmentUploadBudgetAllowed({
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.messageId,
      size: input.size,
    });
    reservedPendingBytes = input.size;
    await writeObject(storageKey, bytes, input.mime);
    await schedulePendingUploadCleanup(input.userId, storageKey);
    return { storageKey };
  } catch (err) {
    await releasePendingUploadBudget(input.userId, reservedPendingBytes);
    if (isApiError(err, "BAD_REQUEST", "CONFLICT", "TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"))
      throw err;
    console.error("[chat] proxied upload failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't store the upload. Try again.");
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
