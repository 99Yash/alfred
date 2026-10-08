import { Errors, isApiError, isPdfContentType, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { enqueuePendingUploadCleanup } from "@alfred/assistant/connections/ingestion";
import { extraction, formatExtractedMediaText, mediaFailureMessage } from "@alfred/extraction";
import {
  assertPassThroughImageBytes,
  assertStoredAttachmentBytesMatch,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  attachmentUrl,
  buildAttachmentKey,
  isStorageConfigured,
  objectExists,
  pdfDegradedArtifactKey,
  readObject,
  type AttachmentDegradation,
  withChatStorageKeyLock,
  writeObject,
} from "./attachments";
import {
  assertAttachmentUploadBudgetAllowed,
  assertAttachmentUploadRateAllowed,
  releasePendingUploadBudget,
} from "./attachment-upload-quota";

/** Chat upload ingest (ADR-0065): quota, duplicate check, decode, bucket write, and owner-scoped read. */

/**
 * Extract text from a PDF. A scanned PDF returns no text and continues. An invalid,
 * encrypted, or over-limit PDF throws, so no ready row is left with nothing readable.
 */
export async function extractChatPdfText(bytes: Uint8Array): Promise<string | null> {
  const media = extraction({ door: "chatUpload" });
  let result: Awaited<ReturnType<typeof media.extract>>;

  try {
    result = await media.extract({ mime: "application/pdf", bytes });
  } catch (err) {
    console.warn("[chat] PDF extraction failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't read the PDF. Try again.");
  }

  if (!result) throw Errors.BadRequestError("Unsupported file type.");

  if (result.kind === "extracted") {
    // Chat text carries `[page N]` markers (ADR-0091 D4).
    return formatExtractedMediaText(result);
  }

  if (result.kind === "needs_ocr") return null;
  throw Errors.BadRequestError(mediaFailureMessage(result));
}

const pdfDegradedArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("needs_ocr") }).strict(),
]);

type PdfDegradedArtifact = z.infer<typeof pdfDegradedArtifactSchema>;

function artifactFromDegradedText(degradedText: string | null): PdfDegradedArtifact {
  return degradedText === null
    ? { version: 1, kind: "needs_ocr" }
    : { version: 1, kind: "text", text: degradedText };
}

function degradedTextFromArtifact(artifact: PdfDegradedArtifact): string | null {
  return artifact.kind === "text" ? artifact.text : null;
}

async function writePdfDegradedArtifact(
  storageKey: string,
  degradedText: string | null,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(artifactFromDegradedText(degradedText)));
  await writeObject(pdfDegradedArtifactKey(storageKey), bytes, "application/json");
}

async function readPdfDegradedArtifact(storageKey: string): Promise<PdfDegradedArtifact | null> {
  const artifactKey = pdfDegradedArtifactKey(storageKey);

  if (!(await objectExists(artifactKey))) return null;
  const bytes = await readObject(artifactKey);
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    console.warn("[chat] stored PDF artifact JSON is invalid:", toMessage(err));

    return null;
  }

  const parsed = pdfDegradedArtifactSchema.safeParse(value);

  if (!parsed.success) {
    console.warn("[chat] stored PDF artifact shape is invalid");

    return null;
  }

  return parsed.data;
}

async function ensurePdfDegradedArtifact(
  storageKey: string,
  fallbackBytes?: Uint8Array,
): Promise<string | null> {
  const artifact = await readPdfDegradedArtifact(storageKey);

  if (artifact) return degradedTextFromArtifact(artifact);

  const bytes = fallbackBytes ?? (await readObject(storageKey));
  const degradedText = await extractChatPdfText(bytes);
  await writePdfDegradedArtifact(storageKey, degradedText);

  return degradedText;
}

/** Read or repair the model-readable state owned by one stored attachment. */
export async function resolveAttachmentDegradation(opts: {
  storageKey: string;
  mime: string;
}): Promise<AttachmentDegradation> {
  if (!isPdfContentType(opts.mime)) return { kind: "image" };

  try {
    return { kind: "pdf", text: await ensurePdfDegradedArtifact(opts.storageKey) };
  } catch (err) {
    if (isApiError(err, "BAD_REQUEST")) throw err;
    console.warn("[chat] PDF artifact read failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't read the uploaded PDF. Try again.");
  }
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
  /** Read on demand: a duplicate row rejects before the read. */
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
 * Write one attachment to the bucket and return its key. The row is written at send time.
 * `reservedPendingBytes` is set only after the checks and before the write, so the
 * `catch` releases exactly what was reserved.
 */
export async function uploadChatAttachment(
  input: UploadChatAttachmentInput,
): Promise<{ storageKey: string }> {
  if (!isStorageConfigured()) {
    throw Errors.ServiceUnavailableError(
      "File uploads aren't configured — set the CHAT_S3_* env vars on the server.",
    );
  }

  assertUploadAllowed(input.mime, input.size);

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

    return await withChatStorageKeyLock(storageKey, async (storageDb) => {
      // An advisory lock shared with admission and cleanup, so no transaction stays open during I/O.
      const existingRows = await storageDb
        .select({ id: chatAttachments.id })
        .from(chatAttachments)
        .where(eq(chatAttachments.id, input.attachmentId))
        .limit(1);

      if (existingRows[0]) {
        throw Errors.ConflictError("Attachment already exists");
      }

      const isPdf = isPdfContentType(input.mime);

      if (await objectExists(storageKey)) {
        const candidateBytes = await input.readBytes();
        const storedBytes = await readObject(storageKey);
        await assertStoredAttachmentReady({
          storageKey,
          mime: input.mime,
          size: input.size,
        });
        assertStoredAttachmentBytesMatch({ storedBytes, candidateBytes });

        if (isPdf) {
          await ensurePdfDegradedArtifact(storageKey, storedBytes);
        }

        await schedulePendingUploadCleanup(input.userId, storageKey);

        return { storageKey };
      }

      const bytes = await input.readBytes();

      const degradation: AttachmentDegradation = isPdf
        ? { kind: "pdf", text: await extractChatPdfText(bytes) }
        : { kind: "image" };

      if (degradation.kind === "image") {
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
      // Schedule cleanup now: if a later write or the turn commit fails, the job reaps the orphan.
      await schedulePendingUploadCleanup(input.userId, storageKey);

      if (degradation.kind === "pdf") {
        await writePdfDegradedArtifact(storageKey, degradation.text);
      }

      return { storageKey };
    });
  } catch (err) {
    await releasePendingUploadBudget(input.userId, reservedPendingBytes);

    if (isApiError(err, "BAD_REQUEST", "CONFLICT", "TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"))
      throw err;
    console.error("[chat] proxied upload failed:", toMessage(err));
    throw Errors.BadGatewayError("Couldn't store the upload. Try again.");
  }
}

/** A presigned GET for one of this user's attachments. Throws for another user's, so an `<img>` redirect is safe. */
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
