import {
  readGmailAttachmentFirstCarrier,
  toMessage,
  type AttachmentContentReference,
} from "@alfred/contracts";
import { indexDocument, sha256, type IndexDocumentResult } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents, type Document } from "@alfred/db/schemas";
import {
  extraction,
  type Extraction,
  type ExtractionDoor,
  type MediaExtractionResult,
} from "@alfred/extraction";
import { extractAttachments, getAttachment, type GmailMessage } from "@alfred/integrations/google";
import type { ExtractedAttachment } from "@alfred/integrations/google";
import { and, eq, inArray, or, sql } from "drizzle-orm";

const GMAIL_MEDIA_DOOR: ExtractionDoor = "gmailAttachment";

/** Bound once for the cheap schedule-time check. Extractors build lazily. */
const DOOR_MEDIA = extraction({ door: GMAIL_MEDIA_DOOR });

/** Per-run attachment ingest counters. `formatMediaTally` logs every field. */
export interface GmailMediaTally {
  attempted: number;
  ingested: number;
  /** Row already existed, or a sibling job won the insert race. Nothing fetched or embedded. */
  deduped: number;
  /**
   * Same content already stored under another `messageId:attachmentId`. Recorded in
   * `metadata.references`.
   */
  referenced: number;
  skipped: number;
  errors: number;
  embedFailures: number;
}

export const ZERO_MEDIA_TALLY: GmailMediaTally = {
  attempted: 0,
  ingested: 0,
  deduped: 0,
  referenced: 0,
  skipped: 0,
  errors: 0,
  embedFailures: 0,
};

/** Render the tally as `key=value` pairs for logs. */
export function formatMediaTally(tally: GmailMediaTally): string {
  return Object.entries(tally)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
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
  /** Test seam for extraction. Formats are limited by what this object accepts. */
  media?: Pick<Extraction, "extract" | "isSupported" | "wouldExceed"> | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<IndexDocumentResult>) | undefined;
}

export interface GmailMediaIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  /** The mail row's timestamp. Attachments share it so a thread reads as one timeline. */
  authoredAt: Date | null;
  deps?: GmailMediaIngestDeps | undefined;
}

/** Stored columns that ingest reads to place a carrier against an existing row. */
type StoredAttachmentRow = Pick<
  Document,
  "id" | "sourceId" | "contentHash" | "accountId" | "sourceThreadId" | "metadata"
>;

const storedAttachmentColumns = {
  id: documents.id,
  sourceId: documents.sourceId,
  contentHash: documents.contentHash,
  accountId: documents.accountId,
  sourceThreadId: documents.sourceThreadId,
  metadata: documents.metadata,
};

type Carrier = {
  messageId: string;
  attachmentId: string;
  accountId: string;
  threadId: string | null;
};

/**
 * Where a carrier stands against a stored row for its part.
 * - `recorded`: the row's first carrier is this carrier.
 * - `backfill`: this carrier's own legacy row, missing carrier ids in `metadata`.
 * - `foreign`: another carrier owns it. Gmail message ids are per mailbox, so a second linked
 *   account can share a `messageId:attachmentId`; that becomes a reference.
 */
function firstCarrierStanding(
  row: StoredAttachmentRow,
  carrier: Carrier,
): "recorded" | "backfill" | "foreign" {
  const first = readGmailAttachmentFirstCarrier(row);

  if (
    row.sourceId !== `${carrier.messageId}:${carrier.attachmentId}` ||
    first.accountId !== carrier.accountId ||
    first.threadId !== carrier.threadId ||
    (first.messageId !== null && first.messageId !== carrier.messageId) ||
    (first.attachmentId !== null && first.attachmentId !== carrier.attachmentId)
  ) {
    return "foreign";
  }

  return first.messageId !== null && first.attachmentId !== null ? "recorded" : "backfill";
}

/**
 * Write first-carrier ids onto this carrier's legacy row. Merge only owned keys: a sibling's
 * `appendContentReference` may rewrite `references` at the same time.
 */
async function backfillFirstCarrier(
  row: StoredAttachmentRow,
  carrier: Carrier,
  att: ExtractedAttachment,
): Promise<void> {
  const owned = {
    messageId: carrier.messageId,
    attachmentId: carrier.attachmentId,
    accountId: carrier.accountId,
    threadId: carrier.threadId,
    filename: att.filename,
    mimeType: att.mimeType,
  };

  await db()
    .update(documents)
    .set({
      metadata: sql`${documents.metadata} || ${JSON.stringify(owned)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, row.id), eq(documents.source, "gmail_attachment")));
}

/** The canonical attachment row with this extracted content, if any. */
async function findCanonicalByContentHash(
  userId: string,
  contentHash: string,
): Promise<StoredAttachmentRow | null> {
  const rows = await db()
    .select(storedAttachmentColumns)
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail_attachment"),
        eq(documents.contentHash, contentHash),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Add an occurrence to the canonical row, idempotent per carrier identity. `IS DISTINCT FROM`, not
 * `=`: an element with a missing key gives NULL, and `=` would drop it. Account and thread are in
 * the identity because Gmail message ids are per mailbox.
 */
export async function appendContentReference(
  documentId: string,
  ref: AttachmentContentReference,
): Promise<void> {
  await db()
    .update(documents)
    .set({
      metadata: sql`${documents.metadata} || jsonb_build_object('references', (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(coalesce(${documents.metadata}->'references', '[]'::jsonb)) AS elem
        WHERE elem->>'messageId' IS DISTINCT FROM ${ref.messageId}
           OR elem->>'attachmentId' IS DISTINCT FROM ${ref.attachmentId}
           OR elem->>'accountId' IS DISTINCT FROM ${ref.accountId}
           OR elem->>'threadId' IS DISTINCT FROM ${ref.threadId}
      ) || ${JSON.stringify([ref])}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));
}

/**
 * Cheap poll-path check: does any attachment have a MIME the Gmail door can extract? Same allowlist
 * as the ingest loop, so a scheduled job never no-ops on support alone.
 */
export function hasIngestableAttachments(message: GmailMessage): boolean {
  return extractAttachments(message).some((att) => DOOR_MEDIA.isSupported(att.mimeType));
}

/**
 * Fetch, extract, persist and embed a message's attachments. Format logic lives in
 * `@alfred/extraction`; add a format there, not a new `gmail-*` file.
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

  // Tests inject `media` to avoid the child process.
  const media = args.deps?.media ?? extraction({ door: GMAIL_MEDIA_DOOR });

  const candidates = attachments.filter((a) => media.isSupported(a.mimeType));

  if (candidates.length === 0) {
    return { ...ZERO_MEDIA_TALLY, documentIds: [] };
  }

  // Dedup layer 1: skip parts already stored. Gmail attachment ids are immutable, so an existing
  // row never gains new content. Applies only to this carrier's own row; a `foreign` row becomes a
  // reference. Layer 2, after extraction, folds identical content by hash. A permanently failed
  // embed dead-letters the row, and dedup treats it as terminal on purpose.
  const sourceIdOf = (att: { attachmentId: string }): string =>
    `${args.message.id}:${att.attachmentId}`;

  const existingRows = await db()
    .select(storedAttachmentColumns)
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail_attachment"),
        inArray(documents.sourceId, candidates.map(sourceIdOf)),
      ),
    );

  const existingBySourceId = new Map(existingRows.map((row) => [row.sourceId, row]));

  const carrierOf = (att: ExtractedAttachment): Carrier => ({
    messageId: args.message.id,
    attachmentId: att.attachmentId,
    accountId: args.accountId,
    threadId: args.message.threadId ?? null,
  });

  const tally: GmailMediaTally = { ...ZERO_MEDIA_TALLY };
  const documentIds: string[] = [];

  const referenceFor = (att: ExtractedAttachment): AttachmentContentReference => ({
    messageId: args.message.id,
    attachmentId: att.attachmentId,
    threadId: args.message.threadId ?? null,
    accountId: args.accountId,
    filename: att.filename,
    mimeType: att.mimeType,
    size: att.size,
    authoredAt: args.authoredAt ? args.authoredAt.toISOString() : null,
  });

  /** Append an occurrence. Returns false on failure, which is counted. */
  const recordOccurrence = async (
    canonicalId: string,
    ref: AttachmentContentReference,
    label: string,
  ): Promise<boolean> => {
    try {
      await appendContentReference(canonicalId, ref);
      tally.referenced++;

      return true;
    } catch (err) {
      tally.errors++;
      console.warn(
        `[gmail.media] reference append failed for ${label} doc=${canonicalId}:`,
        toMessage(err),
      );

      return false;
    }
  };

  for (const att of candidates) {
    tally.attempted++;

    const existing = existingBySourceId.get(sourceIdOf(att));
    const standing = existing ? firstCarrierStanding(existing, carrierOf(att)) : null;

    if (existing && standing !== "foreign") {
      tally.deduped++;

      if (standing === "backfill") {
        try {
          await backfillFirstCarrier(existing, carrierOf(att), att);
        } catch (err) {
          // Counted, so the job keeps `mediaPending` and the next poll retries.
          tally.errors++;
          console.warn(
            `[gmail.media] first-carrier backfill failed for ${att.filename}:`,
            toMessage(err),
          );
        }
      }

      continue;
    }

    // Skip the download when Gmail already reports an over-limit size.
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
      result = await media.extract({ mime: att.mimeType, bytes });
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

    // Dedup layer 2: identical content under another `messageId:attachmentId` is one row (a resume
    // forwarded to ten recruiters). The unique hash index is the race backstop. The hash covers
    // extracted text, not bytes, so an extractor upgrade can mint a second row. Format twins fold
    // too (#878); each reference keeps its mimeType for traceability.
    const canonical = await findCanonicalByContentHash(args.userId, contentHash);

    if (canonical) {
      if (firstCarrierStanding(canonical, carrierOf(att)) === "recorded") {
        tally.deduped++;
        continue;
      }

      await recordOccurrence(canonical.id, referenceFor(att), att.filename);
      continue;
    }

    const metadata = {
      filename: att.filename,
      messageId: args.message.id,
      attachmentId: att.attachmentId,
      accountId: args.accountId,
      threadId: args.message.threadId ?? null,
      mimeType: att.mimeType,
      size: att.size,
      format: result.format,
      // exactOptionalPropertyTypes: omit `pages` rather than set it undefined.
      ...(pages ? { pages } : {}),
    };

    let documentId: string | null = null;

    try {
      // Untargeted, so either unique index (source id or content hash) can win the race.
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
          authoredAt: args.authoredAt,
          raw: { messageId: args.message.id, attachment: att },
        })
        .onConflictDoNothing()
        .returning({ id: documents.id });

      documentId = inserted[0]?.id ?? null;
    } catch (err) {
      tally.errors++;
      console.warn(`[gmail.media] persist failed for ${att.filename}:`, toMessage(err));
      continue;
    }

    if (!documentId) {
      // Lost an insert race: either this exact part exists, or the content's canonical row does.
      // The two unique indexes cap this at two rows, so both picks are deterministic.
      const winners = await db()
        .select(storedAttachmentColumns)
        .from(documents)
        .where(
          and(
            eq(documents.userId, args.userId),
            eq(documents.source, "gmail_attachment"),
            or(eq(documents.sourceId, sourceId), eq(documents.contentHash, contentHash)),
          ),
        );

      // A `foreign` twin is another account's carriage; record this one on the canonical row.
      const twin = winners.find(
        (row) =>
          row.sourceId === sourceId && firstCarrierStanding(row, carrierOf(att)) !== "foreign",
      );

      if (twin) {
        tally.deduped++;
        continue;
      }

      const canon = winners.find((row) => row.contentHash === contentHash);

      if (!canon) {
        tally.errors++;
        continue;
      }

      await recordOccurrence(canon.id, referenceFor(att), att.filename);
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
 * Set or clear `mediaPending` on a mail document. The realtime poll retries only flagged messages.
 * The document-ask reducer also reads it as a completion barrier for a sent sibling carrier.
 * Best-effort: a failed write delays or repeats a retry, but never closes an ask by itself.
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
