import { toMessage, type ContentFamily } from "@alfred/contracts";
import { indexDocument } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  extraction,
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
  embedFailures: number;
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
  /** Override extractor for a MIME — used by tests to avoid the child process. */
  createExtractor?: ((args: { mimeType: string }) => MediaExtractor | null) | undefined;
  /** Restrict ingest to these families. When undefined, all extractable families are allowed. */
  allowedFamilies?: readonly ContentFamily[] | undefined;
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
 * *fetch → extract → persist → embed*. Family-specific concerns
 * (byte-to-text, page offsets, limits) live in `@alfred/extraction` behind
 * `extraction({ door }).extract({ mime, bytes })`. Adding `docx` is one
 * registry entry, not a new `gmail-*` file.
 *
 * Call-site narrative: `extraction({ door }).extract({ mime, bytes })`
 * states the workflow in domain order — choose the ingest door once,
 * then extract each MIME. The caller never names `ContentFamily`,
 * never reads `getContentFamily`, and never handles `limits` or
 * `factory` misses. An unsupported MIME yields `null` (skip); a
 * supported one yields a discriminated `MediaExtractionResult`.
 */
export async function ingestGmailMediaAttachments(
  args: GmailMediaIngestArgs,
): Promise<GmailMediaIngestResult> {
  const attachments = extractAttachments(args.message);
  if (attachments.length === 0) {
    return { attempted: 0, ingested: 0, skipped: 0, errors: 0, embedFailures: 0, documentIds: [] };
  }

  const getAttachmentFn = args.deps?.getAttachment ?? getAttachment;
  const indexDocumentFn = args.deps?.indexDocument ?? indexDocument;

  // Door-bound extraction — one bind, memoized per family. The facade hides
  // `mime → family → gate → limits → factory`, including the `allowedFamilies`
  // ledger. Tests inject via `deps.createExtractor` to avoid the child
  // process; production uses the registry.
  const media = extraction({
    door: GMAIL_MEDIA_DOOR,
    allowedFamilies: args.deps?.allowedFamilies,
  });

  const candidates = attachments.filter((a) => media.isSupported(a.mimeType));
  if (candidates.length === 0) {
    return { attempted: 0, ingested: 0, skipped: 0, errors: 0, embedFailures: 0, documentIds: [] };
  }

  async function extractForMime(
    mime: string,
    bytes: Uint8Array,
  ): Promise<MediaExtractionResult | null> {
    if (args.deps?.createExtractor) {
      const extractor = args.deps.createExtractor({ mimeType: mime });
      if (!extractor) return null;
      return extractor(bytes);
    }
    return media.extract({ mime, bytes });
  }

  let attempted = 0;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  let embedFailures = 0;
  const documentIds: string[] = [];

  for (const att of candidates) {
    attempted++;

    // Pre-fetch hint: avoid the round-trip when Gmail already reports an
    // over-limit part. No limits leak — the facade owns the policy.
    if (media.wouldExceed(att.mimeType, att.size)) {
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

    if (bytes.byteLength === 0) {
      skipped++;
      continue;
    }

    let result: MediaExtractionResult | null;
    try {
      result = await extractForMime(att.mimeType, bytes);
    } catch (err) {
      errors++;
      console.warn(`[gmail.media] extract failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (!result) {
      skipped++;
      continue;
    }

    if (result.kind !== "extracted") {
      skipped++;
      continue;
    }

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
      family: result.family,
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
      embedFailures++;
      console.warn(`[gmail.media] embed failed for doc=${documentId}:`, toMessage(err));
      continue;
    }

    documentIds.push(documentId);
    ingested++;
  }

  return { attempted, ingested, skipped, errors, embedFailures, documentIds };
}
