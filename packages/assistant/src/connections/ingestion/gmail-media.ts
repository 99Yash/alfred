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
 * Module-level door bind for the cheap schedule-time predicate below. Holds
 * no bytes; each family extractor is lazily built and memoized inside.
 */
const DOOR_MEDIA = extraction({ door: GMAIL_MEDIA_DOOR });

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

/**
 * The six per-run counters attachment ingest reports. One home so adding a
 * seventh field is one edit here plus the merge, not six hand-rolled
 * aggregations across the poll entry points.
 */
export interface GmailMediaTally {
  attempted: number;
  ingested: number;
  /** Attachment docs that already existed — download, extraction, and embed all skipped. */
  deduped: number;
  skipped: number;
  errors: number;
  embedFailures: number;
}

export const ZERO_MEDIA_TALLY: GmailMediaTally = {
  attempted: 0,
  ingested: 0,
  deduped: 0,
  skipped: 0,
  errors: 0,
  embedFailures: 0,
};

/** Accumulate one run's counters into a poll-level tally. Mutates `acc`. */
export function mergeMediaTally(
  acc: GmailMediaTally,
  result: GmailMediaIngestResult | null | undefined,
): GmailMediaTally {
  if (!result) return acc;
  acc.attempted += result.attempted;
  acc.ingested += result.ingested;
  acc.deduped += result.deduped;
  acc.skipped += result.skipped;
  acc.errors += result.errors;
  acc.embedFailures += result.embedFailures;
  return acc;
}

export interface GmailMediaIngestResult extends GmailMediaTally {
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
 * Cheap predicate for the poll hot path: does this message carry any
 * attachment whose MIME is extractable under the Gmail door? A message with
 * none must not pay for a `gmail.media_ingest` job. This checks the same
 * whitelist the ingest loop will apply, so a scheduled job never no-ops on
 * support alone (size/limit skips still happen inside the job).
 */
export function hasIngestableAttachments(message: GmailMessage): boolean {
  return extractAttachments(message).some((att) => DOOR_MEDIA.isSupported(att.mimeType));
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
    return { ...ZERO_MEDIA_TALLY, documentIds: [] };
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
    return { ...ZERO_MEDIA_TALLY, documentIds: [] };
  }

  // Skip-if-exists: one indexed SELECT replaces a full attachment download +
  // child-process extraction for every already-ingested part. Gmail
  // attachmentIds are immutable, so an existing `messageId:attachmentId` row
  // can never gain new content. A failed first attempt never persisted a row,
  // so the flagged known-message retry in pollGmailRecent still recovers it.
  // Embed-failure recovery is split by failure class: a transient embed error
  // is retried by the corpus sweep (`gmail.embed_sweep`, which covers BOTH
  // `gmail` and `gmail_attachment` sources), while a permanent one
  // dead-letters the row — dedup then treats it as terminal BY DESIGN, and
  // only an explicit `indexDocument` call revives it.
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

  const tally: GmailMediaTally = { ...ZERO_MEDIA_TALLY };
  const documentIds: string[] = [];

  for (const att of candidates) {
    tally.attempted++;

    // Already ingested — the row exists, so fetch/extract/embed would repeat
    // identical work. See the skip-if-exists note above the loop's query.
    if (existingSourceIds.has(sourceIdOf(att))) {
      tally.deduped++;
      continue;
    }

    // Pre-fetch hint: avoid the round-trip when Gmail already reports an
    // over-limit part. No limits leak — the facade owns the policy.
    if (media.wouldExceed(att.mimeType, att.size)) {
      tally.skipped++;
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
      tally.errors++;
      console.warn(`[gmail.media] fetch failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (bytes.byteLength === 0) {
      tally.skipped++;
      continue;
    }

    let result: MediaExtractionResult | null;
    try {
      result = await extractForMime(att.mimeType, bytes);
    } catch (err) {
      tally.errors++;
      console.warn(`[gmail.media] extract failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (!result) {
      tally.skipped++;
      continue;
    }

    if (result.kind !== "extracted") {
      tally.skipped++;
      continue;
    }

    const content = result.content;
    if (content.trim().length === 0) {
      tally.skipped++;
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
      tally.errors++;
      console.warn(`[gmail.media] persist failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (!documentId) {
      tally.errors++;
      continue;
    }

    try {
      await indexDocumentFn({ documentId });
    } catch (err) {
      tally.embedFailures++;
      console.warn(`[gmail.media] embed failed for doc=${documentId}:`, toMessage(err));
      continue;
    }

    documentIds.push(documentId);
    tally.ingested++;
  }

  return { ...tally, documentIds };
}

/**
 * Mark (or clear) a mail document as having attachment ingest pending. The
 * realtime poll pre-filter uses this flag to retry only known messages whose
 * attachments failed — not every known message in the window. Best-effort:
 * a failed set means the next poll may miss the retry (history catch-up still
 * covers it); a failed clear costs one extra dedup-only retry.
 */
export async function setMediaPending(documentId: string, pending: boolean): Promise<void> {
  try {
    await db()
      .update(documents)
      .set({
        metadata: pending
          ? sql`${documents.metadata} || '{"mediaPending":true}'::jsonb`
          : sql`${documents.metadata} - 'mediaPending'`,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));
  } catch (err) {
    console.warn(
      `[gmail.media] mediaPending=${pending} write failed doc=${documentId}:`,
      toMessage(err),
    );
  }
}
