import {
  documentAskEvidenceSchema,
  getContentFormat,
  parseGmailDocumentMetadata,
  toMessage,
  type AttachmentContentReference,
  type ContentFormat,
  type DocumentAskEvidence,
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
import { classifyGmailAttachmentContent } from "../document-asks/classifier";
import {
  documentAskEvidenceKey,
  projectDocumentAskEvidence,
  type DocumentAskOccurrence,
} from "../document-asks/evidence";

const GMAIL_MEDIA_DOOR: ExtractionDoor = "gmailAttachment";

/** The cheap schedule-time extractor binding; no bytes are held here. */
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
  /** Result-level positive evidence; extracted text never crosses the queue boundary. */
  evidence: DocumentAskEvidence[];
}

type ExistingAttachmentRow = Pick<
  Document,
  | "id"
  | "sourceId"
  | "content"
  | "contentHash"
  | "title"
  | "accountId"
  | "sourceThreadId"
  | "metadata"
>;

type StoredOccurrence = DocumentAskOccurrence;

type EvidenceAccumulator = {
  values: DocumentAskEvidence[];
  keys: Set<string>;
};

function addEvidence(accumulator: EvidenceAccumulator, evidence: DocumentAskEvidence): void {
  const parsed = documentAskEvidenceSchema.parse(evidence);
  const key = documentAskEvidenceKey(parsed);

  if (accumulator.keys.has(key)) return;
  accumulator.keys.add(key);
  accumulator.values.push(parsed);
}

function storedOccurrenceForMessage(
  row: ExistingAttachmentRow,
  messageId: string,
  accountId: string,
  threadId: string | null,
): StoredOccurrence | null {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  const matchesFirstCarrier =
    metadata.messageId === messageId &&
    (metadata.accountId ?? row.accountId) === accountId &&
    (metadata.threadId ?? row.sourceThreadId) === threadId;

  if (!matchesFirstCarrier || !metadata.attachmentId) return null;

  return {
    attachmentId: metadata.attachmentId,
    filename: metadata.filename ?? row.title,
    mimeType: metadata.mimeType ?? null,
  };
}

function canBackfillFirstCarrier(
  row: ExistingAttachmentRow,
  sourceId: string,
  messageId: string,
  attachmentId: string,
  accountId: string,
  threadId: string | null,
): boolean {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  const metadataAccountMatches =
    metadata.accountId === undefined || metadata.accountId === null
      ? row.accountId === accountId
      : metadata.accountId === accountId;

  const metadataThreadMatches =
    metadata.threadId === undefined || metadata.threadId === null
      ? row.sourceThreadId === threadId
      : metadata.threadId === threadId;

  return (
    row.sourceId === sourceId &&
    (metadata.messageId === undefined ||
      metadata.messageId === null ||
      metadata.messageId === messageId) &&
    (metadata.attachmentId === undefined ||
      metadata.attachmentId === null ||
      metadata.attachmentId === attachmentId) &&
    metadataAccountMatches &&
    metadataThreadMatches
  );
}

async function backfillFirstCarrierMetadata(args: {
  row: ExistingAttachmentRow;
  messageId: string;
  attachmentId: string;
  accountId: string;
  threadId: string | null;
  filename: string | null;
  mimeType: string | null;
  format: ContentFormat;
  contentKind: "resume" | "portfolio" | null;
}): Promise<ExistingAttachmentRow | null> {
  const metadata = parseGmailDocumentMetadata(args.row.metadata);

  if (
    !canBackfillFirstCarrier(
      args.row,
      `${args.messageId}:${args.attachmentId}`,
      args.messageId,
      args.attachmentId,
      args.accountId,
      args.threadId,
    )
  ) {
    return null;
  }

  const nextMetadata = {
    ...metadata,
    messageId: args.messageId,
    attachmentId: args.attachmentId,
    accountId: args.accountId,
    threadId: args.threadId,
    filename: args.filename,
    mimeType: args.mimeType,
    format: args.format,
    documentAskContentKind: args.contentKind,
  };

  const rows = await db()
    .update(documents)
    .set({
      metadata: sql`${documents.metadata} || ${JSON.stringify(nextMetadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documents.id, args.row.id),
        eq(documents.source, "gmail_attachment"),
        eq(documents.sourceId, `${args.messageId}:${args.attachmentId}`),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

function storedOccurrenceForReference(
  reference: AttachmentContentReference,
): StoredOccurrence | null {
  if (!reference.accountId || !reference.threadId) return null;

  return {
    attachmentId: reference.attachmentId,
    filename: reference.filename,
    mimeType: reference.mimeType ?? null,
  };
}

function evidenceForStoredAttachment(
  row: ExistingAttachmentRow,
  occurrence: StoredOccurrence,
  formatOverride?: ContentFormat,
): DocumentAskEvidence | null {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  return projectDocumentAskEvidence({
    documentId: row.id,
    content: row.content,
    contentHash: row.contentHash,
    canonicalFormat: metadata.format,
    canonicalMimeType: metadata.mimeType,
    occurrence,
    formatOverride,
  });
}

async function refreshDocumentAskProjection(
  documentId: string,
  contentKind: "resume" | "portfolio" | null,
): Promise<void> {
  await db()
    .update(documents)
    .set({
      metadata: sql`${documents.metadata} || jsonb_build_object('documentAskContentKind', ${JSON.stringify(contentKind)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, documentId), eq(documents.source, "gmail_attachment")));
}

async function findCanonicalByContentHash(
  userId: string,
  contentHash: string,
): Promise<ExistingAttachmentRow | null> {
  const rows = await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      content: documents.content,
      contentHash: documents.contentHash,
      title: documents.title,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
    })
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

/** Record a folded occurrence idempotently, including its carrying account. */
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

export interface GmailMediaIngestDeps {
  getAttachment?:
    | ((args: {
        accessToken: string;
        messageId: string;
        attachmentId: string;
      }) => Promise<{ bytes: Uint8Array; size: number }>)
    | undefined;
  media?: Pick<Extraction, "extract" | "isSupported" | "wouldExceed"> | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<IndexDocumentResult>) | undefined;
}

export interface GmailMediaIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  authoredAt: Date | null;
  deps?: GmailMediaIngestDeps | undefined;
}

export function hasIngestableAttachments(message: GmailMessage): boolean {
  return extractAttachments(message).some((att) => DOOR_MEDIA.isSupported(att.mimeType));
}

/**
 * Fetch, extract, persist, and embed all supported parts, while building one
 * complete result-level evidence list. Reducer observation belongs to the job
 * runner and is deliberately not called from this loop.
 */
export async function ingestGmailMediaAttachments(
  args: GmailMediaIngestArgs,
): Promise<GmailMediaIngestResult> {
  const attachments = extractAttachments(args.message);

  if (attachments.length === 0) return { ...ZERO_MEDIA_TALLY, documentIds: [], evidence: [] };

  const getAttachmentFn = args.deps?.getAttachment ?? getAttachment;
  const indexDocumentFn = args.deps?.indexDocument ?? indexDocument;
  const media = args.deps?.media ?? extraction({ door: GMAIL_MEDIA_DOOR });
  const candidates = attachments.filter((a) => media.isSupported(a.mimeType));

  if (candidates.length === 0) return { ...ZERO_MEDIA_TALLY, documentIds: [], evidence: [] };

  const sourceIdOf = (att: { attachmentId: string }): string =>
    `${args.message.id}:${att.attachmentId}`;

  const existingRows = await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      content: documents.content,
      contentHash: documents.contentHash,
      title: documents.title,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail_attachment"),
        inArray(documents.sourceId, candidates.map(sourceIdOf)),
      ),
    );

  const existingBySourceId = new Map(existingRows.map((row) => [row.sourceId, row]));
  const tally: GmailMediaTally = { ...ZERO_MEDIA_TALLY };
  const documentIds: string[] = [];
  const evidenceAccumulator: EvidenceAccumulator = { values: [], keys: new Set() };

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

  const addStoredEvidence = (
    row: ExistingAttachmentRow,
    occurrence: StoredOccurrence | null,
    format?: ContentFormat,
  ): void => {
    if (!occurrence) return;
    const evidence = evidenceForStoredAttachment(row, occurrence, format);

    if (evidence) addEvidence(evidenceAccumulator, evidence);
  };

  const refreshProjection = async (
    documentId: string,
    contentKind: "resume" | "portfolio" | null,
  ): Promise<void> => {
    try {
      await refreshDocumentAskProjection(documentId, contentKind);
    } catch (err) {
      // The cache is advisory; the next pass reclassifies stored content.
      console.warn(
        `[gmail.media] document-ask projection refresh failed for doc=${documentId}:`,
        toMessage(err),
      );
    }
  };

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
    const sourceId = sourceIdOf(att);
    const occurrence = referenceFor(att);

    const existing = existingBySourceId.get(sourceId);

    if (
      existing &&
      (storedOccurrenceForMessage(
        existing,
        args.message.id,
        args.accountId,
        args.message.threadId ?? null,
      ) !== null ||
        canBackfillFirstCarrier(
          existing,
          sourceId,
          args.message.id,
          att.attachmentId,
          args.accountId,
          args.message.threadId ?? null,
        ))
    ) {
      tally.deduped++;

      let storedRow = existing;

      let storedOccurrence = storedOccurrenceForMessage(
        storedRow,
        args.message.id,
        args.accountId,
        args.message.threadId ?? null,
      );

      if (!storedOccurrence) {
        const format =
          getContentFormat(att.mimeType) ?? parseGmailDocumentMetadata(storedRow.metadata).format;

        if (!format) continue;

        const contentKind = classifyGmailAttachmentContent({
          content: storedRow.content,
          filename: att.filename,
          mimeType: att.mimeType,
          format,
        });

        try {
          storedRow =
            (await backfillFirstCarrierMetadata({
              row: storedRow,
              messageId: args.message.id,
              attachmentId: att.attachmentId,
              accountId: args.accountId,
              threadId: args.message.threadId ?? null,
              filename: att.filename,
              mimeType: att.mimeType,
              format,
              contentKind,
            })) ?? storedRow;
          storedOccurrence = storedOccurrenceForMessage(
            storedRow,
            args.message.id,
            args.accountId,
            args.message.threadId ?? null,
          );
        } catch (err) {
          tally.errors++;
          console.warn(
            `[gmail.media] first-carrier metadata backfill failed for ${att.filename}:`,
            toMessage(err),
          );
          continue;
        }
      }

      if (storedOccurrence) {
        const evidence = evidenceForStoredAttachment(
          storedRow,
          storedOccurrence,
          getContentFormat(att.mimeType) ?? undefined,
        );

        if (evidence) addEvidence(evidenceAccumulator, evidence);

        // Reclassification is authoritative even when the result is null; do
        // not leave an old semantic cache looking like current evidence.
        await refreshProjection(storedRow.id, evidence?.contentKind ?? null);
      }

      continue;
    }

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

    if (!result || result.kind !== "extracted") {
      tally.skipped++;
      continue;
    }

    const content = result.content;

    if (content.trim().length === 0) {
      tally.skipped++;
      continue;
    }

    const contentHash = sha256(content);

    const contentKind = classifyGmailAttachmentContent({
      content,
      filename: att.filename,
      mimeType: att.mimeType,
      format: result.format,
    });

    const pages = result.pages && result.pages.length > 0 ? result.pages : null;
    const canonical = await findCanonicalByContentHash(args.userId, contentHash);

    if (canonical) {
      const canonicalOccurrence = storedOccurrenceForMessage(
        canonical,
        args.message.id,
        args.accountId,
        args.message.threadId ?? null,
      );

      if (canonical.sourceId === sourceId && canonicalOccurrence) {
        tally.deduped++;
        addStoredEvidence(canonical, canonicalOccurrence, result.format);
        await refreshProjection(canonical.id, contentKind);
        continue;
      }

      if (await recordOccurrence(canonical.id, occurrence, att.filename)) {
        addStoredEvidence(canonical, storedOccurrenceForReference(occurrence), result.format);
        await refreshProjection(canonical.id, contentKind);
      }

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
      documentAskContentKind: contentKind,
      ...(pages ? { pages } : {}),
    };

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
      const winners = await db()
        .select({
          id: documents.id,
          sourceId: documents.sourceId,
          content: documents.content,
          contentHash: documents.contentHash,
          title: documents.title,
          accountId: documents.accountId,
          sourceThreadId: documents.sourceThreadId,
          metadata: documents.metadata,
        })
        .from(documents)
        .where(
          and(
            eq(documents.userId, args.userId),
            eq(documents.source, "gmail_attachment"),
            or(eq(documents.sourceId, sourceId), eq(documents.contentHash, contentHash)),
          ),
        );

      const twin = winners.find((row) => row.sourceId === sourceId);

      const twinOccurrence = twin
        ? storedOccurrenceForMessage(
            twin,
            args.message.id,
            args.accountId,
            args.message.threadId ?? null,
          )
        : null;

      if (twin && twinOccurrence) {
        tally.deduped++;
        addStoredEvidence(twin, twinOccurrence, result.format);
        await refreshProjection(twin.id, contentKind);
        continue;
      }

      const canonicalWinner = winners.find((row) => row.contentHash === contentHash);

      if (!canonicalWinner) {
        if (twin) {
          console.warn(
            `[gmail.media] source identity collision for ${sourceId}; leaving attachment untrusted`,
          );
          continue;
        }

        tally.errors++;
        continue;
      }

      if (await recordOccurrence(canonicalWinner.id, occurrence, att.filename)) {
        addStoredEvidence(canonicalWinner, storedOccurrenceForReference(occurrence), result.format);
        await refreshProjection(canonicalWinner.id, contentKind);
      }

      continue;
    }

    if (contentKind) {
      const evidence = projectDocumentAskEvidence({
        documentId,
        content,
        contentHash,
        canonicalFormat: result.format,
        canonicalMimeType: att.mimeType,
        occurrence: {
          attachmentId: att.attachmentId,
          filename: att.filename,
          mimeType: att.mimeType,
        },
        formatOverride: result.format,
      });

      if (evidence) addEvidence(evidenceAccumulator, evidence);
    }

    try {
      await indexDocumentFn({ documentId });
      documentIds.push(documentId);
      tally.ingested++;
    } catch (err) {
      tally.embedFailures++;
      console.warn(`[gmail.media] embed failed for doc=${documentId}:`, toMessage(err));
    }
  }

  return { ...tally, documentIds, evidence: evidenceAccumulator.values };
}

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
