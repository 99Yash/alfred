import { isPdfContentType, toMessage } from "@alfred/contracts";
import { indexDocument } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  createPdfExtractor,
  REALTIME_PDF_EXTRACTION_LIMITS,
  type ExtractPdf,
} from "@alfred/extraction";
import { extractAttachments, getAttachment, type GmailMessage } from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";
import { internalDateToDate, sha256 } from "./gmail-ingest-helpers";

// Single source of truth for the gmail_attachment door — mirrors REALTIME_PDF_EXTRACTION_LIMITS.gmailAttachment
const GMAIL_ATTACHMENT_PDF_LIMITS = REALTIME_PDF_EXTRACTION_LIMITS.gmailAttachment;

export interface GmailAttachmentIngestResult {
  attempted: number;
  ingested: number;
  skipped: number;
  errors: number;
  documentIds: string[];
}

export interface GmailAttachmentIngestDeps {
  getAttachment?:
    | ((args: {
        accessToken: string;
        messageId: string;
        attachmentId: string;
      }) => Promise<{ bytes: Uint8Array; size: number }>)
    | undefined;
  extractPdf?: ExtractPdf | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<unknown>) | undefined;
}

export interface GmailAttachmentIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  deps?: GmailAttachmentIngestDeps | undefined;
}

export async function ingestGmailPdfAttachments(
  args: GmailAttachmentIngestArgs,
): Promise<GmailAttachmentIngestResult> {
  const attachments = extractAttachments(args.message).filter((a) => isPdfContentType(a.mimeType));
  if (attachments.length === 0) {
    return { attempted: 0, ingested: 0, skipped: 0, errors: 0, documentIds: [] };
  }

  const getAttachmentFn = args.deps?.getAttachment ?? getAttachment;
  const extractPdf = args.deps?.extractPdf ?? createPdfExtractor(GMAIL_ATTACHMENT_PDF_LIMITS);
  const indexDocumentFn = args.deps?.indexDocument ?? indexDocument;

  let attempted = 0;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  const documentIds: string[] = [];

  for (const att of attachments) {
    attempted++;
    if (att.size > 0 && att.size > GMAIL_ATTACHMENT_PDF_LIMITS.maxBytes) {
      skipped++;
      continue;
    }

    try {
      const fetched = await getAttachmentFn({
        accessToken: args.accessToken,
        messageId: args.message.id,
        attachmentId: att.attachmentId,
      });
      const bytes = fetched.bytes;
      if (bytes.byteLength > GMAIL_ATTACHMENT_PDF_LIMITS.maxBytes) {
        skipped++;
        continue;
      }
      if (bytes.byteLength === 0) {
        skipped++;
        continue;
      }

      let result: Awaited<ReturnType<ExtractPdf>>;
      try {
        result = await extractPdf(bytes);
      } catch (err) {
        errors++;
        console.warn(`[gmail.attachment] extract failed for ${att.filename}:`, toMessage(err));
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

      let content: string;
      let pages: { page: number; start: number; end: number }[] | null = null;

      if (result.kind === "extracted") {
        const markdowns: string[] = [];
        const pageOffsets: { page: number; start: number; end: number }[] = [];
        let offset = 0;
        for (let i = 0; i < result.pages.length; i++) {
          const page = result.pages[i]!;
          const text = page.markdown;
          markdowns.push(text);
          if (text.length > 0) {
            const start = offset;
            const end = start + text.length;
            pageOffsets.push({ page: page.pageNumber, start, end });
          }
          offset += text.length;
          if (i < result.pages.length - 1) offset += 2; // "\n\n"
        }
        content = markdowns.join("\n\n");
        if (content.trim().length === 0) {
          skipped++;
          continue;
        }
        pages = pageOffsets.length > 0 ? pageOffsets : null;
      } else {
        content = result.text;
        if (content.trim().length === 0) {
          skipped++;
          continue;
        }
        pages = null;
      }

      const sourceId = `${args.message.id}:${att.attachmentId}`;
      const contentHash = sha256(content);
      const metadata: Record<string, unknown> = {
        filename: att.filename,
        messageId: args.message.id,
        attachmentId: att.attachmentId,
        mimeType: att.mimeType,
        size: att.size,
      };
      if (pages) metadata.pages = pages;

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

      let documentId: string | null = inserted[0]?.id ?? null;
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
      if (!documentId) {
        errors++;
        continue;
      }

      try {
        await indexDocumentFn({ documentId });
      } catch (err) {
        console.warn(`[gmail.attachment] embed failed for doc=${documentId}:`, toMessage(err));
      }

      documentIds.push(documentId);
      ingested++;
    } catch (err) {
      errors++;
      console.warn(`[gmail.attachment] ingest failed for ${att.filename}:`, toMessage(err));
    }
  }

  return { attempted, ingested, skipped, errors, documentIds };
}
