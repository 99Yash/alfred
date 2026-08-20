import { getContentFamily, toMessage, type ContentFamily } from "@alfred/contracts";
import { indexDocument } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  createMediaExtractor,
  extractionLimitsFor,
  type ExtractionDoor,
  type MediaExtractor,
  type MediaExtractionResult,
} from "@alfred/extraction";
import { extractAttachments, getAttachment, type GmailMessage } from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";
import { internalDateToDate, sha256 } from "./gmail-ingest-helpers";

const GMAIL_MEDIA_DOOR: ExtractionDoor = "gmailAttachment";

export interface GmailMediaIngestResult {
  attempted: number;
  ingested: number;
  skipped: number;
  errors: number;
  documentIds: string[];
}

export interface GmailMediaIngestDeps {
  getAttachment?:
    | ((args: {
        accessToken: string;
        messageId: string;
        attachmentId: string;
      }) => Promise<{ bytes: Uint8Array; size: number }>)
    | undefined;
  /** Override extractor for a family — used by tests to avoid the child process. */
  createExtractor?:
    | ((args: { family: ContentFamily; mimeType: string }) => MediaExtractor | null)
    | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<unknown>) | undefined;
}

export interface GmailMediaIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  deps?: GmailMediaIngestDeps | undefined;
}

/**
 * Common ingest for Gmail attachments of any `contentFamily`. The loop owns
 * *fetch → limit → extract → persist → embed*. Family-specific concerns
 * (byte-to-text, page offsets) live in `@alfred/extraction` behind
 * `createMediaExtractor`. Adding `docx` is one registry entry, not a new
 * `gmail-*` file.
 */
export async function ingestGmailMediaAttachments(
  args: GmailMediaIngestArgs,
): Promise<GmailMediaIngestResult> {
  const attachments = extractAttachments(args.message);
  // Keep only families we know how to extract. Pass-through images and
  // unknown mimes have no `contentFamily` and are silently ignored — they
  // never reach the extractor and never become a `gmail_attachment` document.
  const candidates = attachments.filter((a) => getContentFamily(a.mimeType) !== null);
  if (candidates.length === 0) {
    return { attempted: 0, ingested: 0, skipped: 0, errors: 0, documentIds: [] };
  }

  const getAttachmentFn = args.deps?.getAttachment ?? getAttachment;
  const createExtractorFn =
    args.deps?.createExtractor ??
    ((opts: { family: ContentFamily }) => createMediaExtractor(GMAIL_MEDIA_DOOR, opts.family));
  const indexDocumentFn = args.deps?.indexDocument ?? indexDocument;

  let attempted = 0;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  const documentIds: string[] = [];

  for (const att of candidates) {
    const family = getContentFamily(att.mimeType);
    if (!family) {
      skipped++;
      continue;
    }

    const limits = extractionLimitsFor(GMAIL_MEDIA_DOOR, family);
    const extractor = createExtractorFn({ family, mimeType: att.mimeType });
    if (!extractor) {
      skipped++;
      continue;
    }

    attempted++;

    // Pre-fetch size guard — mirrors the post-fetch check but avoids the
    // round-trip when Gmail already reports an over-limit part.
    if (att.size > 0 && att.size > limits.maxBytes) {
      skipped++;
      continue;
    }

    let bytes: Uint8Array;
    try {
      const fetched = await getAttachmentFn({
        accessToken: args.accessToken,
        messageId: args.message.id,
        attachmentId: att.attachmentId,
      });
      bytes = fetched.bytes;
    } catch (err) {
      errors++;
      console.warn(`[gmail.media] fetch failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (bytes.byteLength > limits.maxBytes) {
      skipped++;
      continue;
    }
    if (bytes.byteLength === 0) {
      skipped++;
      continue;
    }

    let result: MediaExtractionResult;
    try {
      result = await extractor(bytes);
    } catch (err) {
      errors++;
      console.warn(`[gmail.media] extract failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (
      result.kind === "needs_ocr" ||
      result.kind === "encrypted" ||
      result.kind === "invalid" ||
      result.kind === "limit_exceeded"
    ) {
      skipped++;
      continue;
    }

    // `extracted` is the only success shape after the guard above.
    const content = result.content;
    if (content.trim().length === 0) {
      skipped++;
      continue;
    }
    const pages = result.pages && result.pages.length > 0 ? result.pages : null;

    const sourceId = `${args.message.id}:${att.attachmentId}`;
    const contentHash = sha256(content);
    const metadata: Record<string, unknown> = {
      filename: att.filename,
      messageId: args.message.id,
      attachmentId: att.attachmentId,
      mimeType: att.mimeType,
      size: att.size,
      family,
    };
    if (pages) metadata.pages = pages;

    let documentId: string | null = null;
    try {
      const inserted = await db()
        .insert(documents)
        .values({
          userId: args.userId,
          source: "gmail_attachment",
          sourceId,
          sourceThreadId: args.message.threadId ?? null,
          accountId: args.accountId,
          title: att.filename,
          content,
          contentHash,
          metadata,
          authoredAt: internalDateToDate(args.message.internalDate),
          raw: { messageId: args.message.id, attachment: att },
        })
        .onConflictDoUpdate({
          target: [documents.userId, documents.source, documents.sourceId],
          set: {
            title: sql`excluded.title`,
            content: sql`excluded.content`,
            contentHash: sql`excluded.content_hash`,
            metadata: sql`excluded.metadata`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: documents.id });

      documentId = inserted[0]?.id ?? null;
      if (!documentId) {
        const rows = await db()
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.userId, args.userId),
              eq(documents.source, "gmail_attachment"),
              eq(documents.sourceId, sourceId),
            ),
          );
        documentId = rows[0]?.id ?? null;
      }
    } catch (err) {
      errors++;
      console.warn(`[gmail.media] persist failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (!documentId) {
      errors++;
      continue;
    }

    try {
      await indexDocumentFn({ documentId });
    } catch (err) {
      console.warn(`[gmail.media] embed failed for doc=${documentId}:`, toMessage(err));
    }

    documentIds.push(documentId);
    ingested++;
  }

  return { attempted, ingested, skipped, errors, documentIds };
}
