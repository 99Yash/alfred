import { toMessage, type ContentFamily } from "@alfred/contracts";
import { indexDocument, sha256 } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  extraction,
  type ExtractionDoor,
  type MediaExtractor,
  type MediaExtractionResult,
} from "@alfred/extraction";
import { extractAttachments, getAttachment, type GmailMessage } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";

const GMAIL_MEDIA_DOOR: ExtractionDoor = "gmailAttachment";

/**
 * Convert Gmail's `internalDate` (ms-since-epoch as string) to a Date.
 * Returns null when missing or non-numeric — the column is nullable.
 */
export function internalDateToDate(internalDate: string | undefined): Date | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

export interface GmailMediaIngestResult {
  attempted: number;
  ingested: number;
  /** Attachment docs that already existed — download, extraction, and embed all skipped. */
  deduped: number;
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
 * Ingest for any `contentFamily`. The loop owns fetch → extract → persist → embed.
 * Family logic (bytes → text, page offsets, limits) lives in
 * `@alfred/extraction` behind `extraction({ door }).extract({ mime, bytes })`.
 * Add a family with one registry entry, not a new `gmail-*` file.
 * The caller binds the door once, then extracts each MIME.
 * Unsupported MIME yields null (skip); supported yields `MediaExtractionResult`.
 */
export async function ingestGmailMediaAttachments(
  args: GmailMediaIngestArgs,
): Promise<GmailMediaIngestResult> {
  const attachments = extractAttachments(args.message);
  if (attachments.length === 0) {
    return {
      attempted: 0,
      ingested: 0,
      deduped: 0,
      skipped: 0,
      errors: 0,
      embedFailures: 0,
      documentIds: [],
    };
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
    return {
      attempted: 0,
      ingested: 0,
      deduped: 0,
      skipped: 0,
      errors: 0,
      embedFailures: 0,
      documentIds: [],
    };
  }

  // Skip-if-exists: one indexed SELECT replaces a full attachment download +
  // child-process extraction for every already-ingested part. Gmail
  // attachmentIds are immutable, so an existing `messageId:attachmentId` row
  // can never gain new content. A failed first attempt never persisted a row,
  // so the known-message retry in pollGmailRecent still recovers it; a row
  // that persisted but failed to embed is recovered by the corpus sweep
  // (`retryPending`), not by re-downloading.
  const sourceIdOf = (att: { attachmentId: string }): string =>
    `${args.message.id}:${att.attachmentId}`;
  const existingRows = await db()
    .select({ sourceId: documents.sourceId })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail_attachment"),
        inArray(documents.sourceId, candidates.map(sourceIdOf)),
      ),
    );
  const existingSourceIds = new Set(existingRows.map((row) => row.sourceId));

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
  let deduped = 0;
  let skipped = 0;
  let errors = 0;
  let embedFailures = 0;
  const documentIds: string[] = [];

  for (const att of candidates) {
    attempted++;

    // Already ingested — the row exists, so fetch/extract/embed would repeat
    // identical work. See the skip-if-exists note above the loop's query.
    if (existingSourceIds.has(sourceIdOf(att))) {
      deduped++;
      continue;
    }

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

    const sourceId = sourceIdOf(att);
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

  return { attempted, ingested, deduped, skipped, errors, embedFailures, documentIds };
}
