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

/**
 * Module-level door bind for the cheap schedule-time predicate below. Holds
 * no bytes; each format extractor is lazily built and memoized inside.
 */
const DOOR_MEDIA = extraction({ door: GMAIL_MEDIA_DOOR });

/**
 * The seven per-run counters attachment ingest reports. One home so adding an
 * eighth field is one edit here — `formatMediaTally` renders it in logs
 * with no call-site change.
 */
export interface GmailMediaTally {
  attempted: number;
  ingested: number;
  /** Attachment docs whose row already existed — download, extraction, and embed all skipped. Also covers an insert race lost to a sibling job that persisted this same part. */
  deduped: number;
  /**
   * Occurrences of content that is already stored under a DIFFERENT
   * `messageId:attachmentId` — the same unchanged file forwarded to another
   * thread. No new row and no embed; the occurrence rides
   * `metadata.references` on the canonical document.
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

/** Render the tally as a `key=value` log fragment. New fields log automatically. */
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
  /**
   * Test seam — overrides door-bound extraction. Same composed shape
   * `fetch-url` injects: tests restrict formats by what this object's
   * `isSupported`/`extract` accept, not by a separate format list.
   */
  media?: Pick<Extraction, "extract" | "isSupported" | "wouldExceed"> | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<IndexDocumentResult>) | undefined;
}

export interface GmailMediaIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  /**
   * The mail row's timestamp, resolved by the caller that owns the mail
   * persist path. Attachment rows share it so a thread reads as one
   * timeline; null keeps the column null.
   */
  authoredAt: Date | null;
  deps?: GmailMediaIngestDeps | undefined;
}

/**
 * One recorded occurrence of the canonical document's content arriving under
 * a different `messageId:attachmentId`. Lives in `metadata.references` on the
 * canonical row, so a chat question can trace a document back to every
 * thread that carried it — including threads whose own ingest never created
 * a row. The shape is owned by `@alfred/contracts`
 * (`AttachmentContentReference`) so retrieval parses the persisted jsonb
 * against the same contract this writer fulfills.
 */

/** The stored columns ingest reads to place one carrier against an existing row. */
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

/** The mail this job is ingesting, as the first-carrier identity names it. */
type Carrier = {
  messageId: string;
  attachmentId: string;
  accountId: string;
  threadId: string | null;
};

/**
 * Where one carrier stands against a stored row that holds its part.
 *
 * - `recorded`: the row's first-carrier identity is this exact carrier.
 * - `backfill`: the row is this carrier's own part, but a legacy insert left
 *   the carrier ids out of `metadata`; ingest writes them.
 * - `foreign`: another carrier owns the row. Gmail message ids are
 *   mailbox-scoped, so a second linked account can carry the same
 *   `messageId:attachmentId`; that carriage is a `references` entry.
 *
 * The document-ask reducer grants evidence only from a `recorded` identity or
 * a matching `references` entry, and both read `readGmailAttachmentFirstCarrier`.
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
 * Write the first-carrier ids onto this carrier's own legacy row. The merge
 * names only the keys this function owns: a sibling job's concurrent
 * `appendContentReference` rewrites `references` on the same row, and a
 * spread of the `metadata` this loop read would put the old array back.
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

/** The canonical attachment row for this exact extracted content, if one exists. */
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
 * Record an occurrence on the canonical row. Idempotent per
 * `(messageId, attachmentId)`: the append rewrites `metadata.references`
 * from the stored array plus only entries it does not already hold, so a
 * retried job cannot stack duplicates. The predicate uses IS DISTINCT FROM,
 * not `=`: SQL NULL from an element missing a key must keep the element
 * (`NOT (NULL AND …)` filters it out and would delete it silently).
 * `accountId` and `threadId` are part of the identity because Gmail message
 * ids are mailbox-scoped: two linked accounts can carry the same
 * `messageId:attachmentId`, and each carriage is its own entry. Legacy entries
 * written with a null account are exactly the NULL case above, so they stay.
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
 * Ingest for any `contentFormat`. The loop owns fetch → extract → persist → embed.
 * Format logic (bytes → text, page offsets, limits) lives in
 * `@alfred/extraction` behind `extraction({ door }).extract({ mime, bytes })`.
 * Add a format with one registry entry, not a new `gmail-*` file.
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

  // Door-bound extraction — one bind, memoized per format. The facade hides
  // `mime → format → gate → limits → factory`. Tests inject the whole
  // `media` object to avoid the child process; production uses the registry.
  const media = args.deps?.media ?? extraction({ door: GMAIL_MEDIA_DOOR });

  const candidates = attachments.filter((a) => media.isSupported(a.mimeType));

  if (candidates.length === 0) {
    return { ...ZERO_MEDIA_TALLY, documentIds: [] };
  }

  // Skip-if-exists: one indexed SELECT replaces a full attachment download +
  // child-process extraction for every already-ingested part. Gmail
  // attachmentIds are immutable, so an existing `messageId:attachmentId` row
  // can never gain new content. A failed first attempt never persisted a row,
  // so the flagged known-message retry in pollGmailRecent still recovers it.
  // This is the FIRST of two dedup layers: after extraction, a second lookup
  // on (userId, source, contentHash) folds repeated identical content — the
  // same unchanged file forwarded under new attachment ids — into one
  // canonical row plus `metadata.references` entries.
  // Embed-failure recovery is split by failure class: a transient embed error
  // is retried by the corpus sweep (`gmail.embed_sweep`, which covers BOTH
  // `gmail` and `gmail_attachment` sources), while a permanent one
  // dead-letters the row — dedup then treats it as terminal BY DESIGN, and
  // only an explicit `indexDocument` call revives it.
  // The skip applies only to this carrier's own row (`recorded`/`backfill`
  // below). A `foreign` row with the same source id belongs to another linked
  // account, so this carriage falls through and lands as a reference.
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

  /** The occurrence record one carrying mail contributes to a canonical doc. */
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

  /** Append an occurrence to the canonical row; false on failure (counted). */
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

    // Already ingested — the row exists, so fetch/extract/embed would repeat
    // identical work. See the skip-if-exists note above the loop's query.
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

    // Content-level dedup (cross-message): the same unchanged file arriving
    // under a different `messageId:attachmentId` — a resume forwarded to ten
    // recruiters is ONE corpus row. The unique index on
    // (userId, source, contentHash) is the race backstop; this lookup avoids
    // the insert-race fallback on the repeat path, at the cost of one extra
    // indexed SELECT per fresh candidate. The occurrence rides the
    // canonical row's `metadata.references`, so chat can still trace the
    // document back to the thread that carried it.
    // Known, accepted edge: `contentHash` covers normalized extractor text,
    // not bytes. Upgrading an extractor changes that text and mints a second
    // canonical row for byte-identical files — dedup decays until a re-index,
    // deliberately not salted with an extractor version (salting cannot
    // prevent the duplicate; it only renames the cause).
    // Format twins (decided in #878): identical extracted text folds across
    // mimeTypes — one logical document — and each reference entry now carries
    // the carrier's mimeType, so a folded .txt/.pdf pair stays traceable at
    // retrieval instead of the second format vanishing without trace.
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
      // exactOptionalPropertyTypes: omit `pages` entirely rather than set it undefined.
      ...(pages ? { pages } : {}),
    };

    let documentId: string | null = null;

    try {
      // `onConflictDoNothing` (not a targeted upsert) so EITHER unique index
      // can win the concurrent-poll race: an identical part persisted by a
      // sibling job, or identical content claiming the hash index. The
      // fallback below resolves which.
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
      // Lost an insert race. Either this exact part now exists (identical
      // content — nothing to add), or the content's canonical row does
      // (record the occurrence on it). The two unique indexes cap the
      // result at two rows — one per index — so both picks below are
      // deterministic by construction.
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

      // A `foreign` twin is another account's carriage of the same source id;
      // this carriage then belongs on the content's canonical row instead.
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
 * Mark (or clear) a mail document as having attachment ingest pending. The
 * realtime poll pre-filter uses this flag to retry only known messages whose
 * attachments failed — not every known message in the window. Best-effort:
 * a failed set means the next poll may miss the retry (history catch-up still
 * covers it); a failed clear costs one extra dedup-only retry.
 * The document-ask reducer also reads the flag as a completion barrier on a
 * sent sibling carrier. A failed clear can then hold an older ask live until
 * the barrier's settle bound passes; a failed set can let a sibling resolve
 * before this carrier's attachments land. Neither closes an ask on its own.
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
