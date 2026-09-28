import {
  contentFormatSchema,
  documentAskEvidenceSourceSchema,
  documentAskKindSchema,
  documentAskStatusSchema,
  type ContentFormat,
  type DocumentAskEvidenceSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documentAsks, type DocumentAskRow, type NewDocumentAsk } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

type CreateIfAbsentInput = Pick<
  NewDocumentAsk,
  "userId" | "accountId" | "sourceMessageId" | "threadId" | "requestedKind" | "askedAt"
>;

type ResolveIfActiveInput = Pick<
  DocumentAskRow,
  "id" | "userId" | "accountId" | "threadId" | "sourceMessageId" | "requestedKind"
> & {
  carrierMessageId: string;
  attachmentDocumentId: string;
  attachmentId: string;
  attachmentContentHash: string;
  attachmentFormat: ContentFormat;
  observedAt: Date;
};

function rowToDocumentAsk(row: DocumentAskRow): DocumentAskRow {
  return {
    ...row,
    requestedKind: documentAskKindSchema.parse(row.requestedKind),
    status: documentAskStatusSchema.parse(row.status),
    resolvedAttachmentFormat:
      row.resolvedAttachmentFormat === null
        ? null
        : contentFormatSchema.parse(row.resolvedAttachmentFormat),
    resolvedContentKind:
      row.resolvedContentKind === null
        ? null
        : documentAskKindSchema.parse(row.resolvedContentKind),
    resolvedEvidenceSource:
      row.resolvedEvidenceSource === null
        ? null
        : documentAskEvidenceSourceSchema.parse(row.resolvedEvidenceSource),
  };
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("[document-ask] observedAt must be a valid Date");
  }

  return new Date(value.getTime());
}

/**
 * Insert one account-qualified source identity, or return the first accepted row
 * without rewriting its requested kind. The unique index is the race gate.
 */
export async function createIfAbsent(
  input: CreateIfAbsentInput,
): Promise<{ ask: DocumentAskRow; created: boolean }> {
  const requestedKind = documentAskKindSchema.parse(input.requestedKind);

  const inserted = await db()
    .insert(documentAsks)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      sourceMessageId: input.sourceMessageId,
      threadId: input.threadId,
      requestedKind,
      askedAt: input.askedAt,
    })
    .onConflictDoNothing({
      target: [documentAsks.userId, documentAsks.accountId, documentAsks.sourceMessageId],
    })
    .returning();

  const createdRow = inserted[0];

  if (createdRow) return { ask: rowToDocumentAsk(createdRow), created: true };

  const existing = await db()
    .select()
    .from(documentAsks)
    .where(
      and(
        eq(documentAsks.userId, input.userId),
        eq(documentAsks.accountId, input.accountId),
        eq(documentAsks.sourceMessageId, input.sourceMessageId),
      ),
    )
    .limit(1);

  const existingRow = existing[0];

  if (!existingRow) {
    throw new Error("[document-ask] insert conflicted but the source identity cannot be read");
  }

  return { ask: rowToDocumentAsk(existingRow), created: false };
}

/** Read the durable row after replay so a racing observer cannot stale the public result. */
export async function readById(userId: string, id: string): Promise<DocumentAskRow | null> {
  const rows = await db()
    .select()
    .from(documentAsks)
    .where(and(eq(documentAsks.userId, userId), eq(documentAsks.id, id)))
    .limit(1);

  const row = rows[0];

  return row ? rowToDocumentAsk(row) : null;
}

/** Read the active projection for one account-qualified Gmail thread. */
export async function readActiveForThread(
  userId: string,
  accountId: string,
  threadId: string,
): Promise<DocumentAskRow[]> {
  const rows = await db()
    .select()
    .from(documentAsks)
    .where(
      and(
        eq(documentAsks.userId, userId),
        eq(documentAsks.accountId, accountId),
        eq(documentAsks.threadId, threadId),
        eq(documentAsks.status, "active"),
      ),
    );

  return rows.map(rowToDocumentAsk);
}

/**
 * Absorbing active-to-resolved transition. Every accepted evidence field is in
 * the same conditional UPDATE; a racing or stale writer gets `not_current`.
 */
export async function resolveIfActive(
  input: ResolveIfActiveInput,
): Promise<DocumentAskRow | "not_current"> {
  const observedAt = requireDate(input.observedAt);
  const requestedKind = documentAskKindSchema.parse(input.requestedKind);
  const attachmentFormat = contentFormatSchema.parse(input.attachmentFormat);

  const evidenceSource: DocumentAskEvidenceSource =
    documentAskEvidenceSourceSchema.parse("extracted_content");

  const updated = await db()
    .update(documentAsks)
    .set({
      status: "resolved",
      resolvedAt: observedAt,
      resolvedCarrierMessageId: input.carrierMessageId,
      resolvedAttachmentDocumentId: input.attachmentDocumentId,
      resolvedAttachmentId: input.attachmentId,
      resolvedAttachmentContentHash: input.attachmentContentHash,
      resolvedAttachmentFormat: attachmentFormat,
      resolvedContentKind: requestedKind,
      resolvedEvidenceSource: evidenceSource,
      updatedAt: observedAt,
    })
    .where(
      and(
        eq(documentAsks.id, input.id),
        eq(documentAsks.userId, input.userId),
        eq(documentAsks.accountId, input.accountId),
        eq(documentAsks.threadId, input.threadId),
        eq(documentAsks.sourceMessageId, input.sourceMessageId),
        eq(documentAsks.status, "active"),
        eq(documentAsks.requestedKind, requestedKind),
      ),
    )
    .returning();

  const row = updated[0];

  return row ? rowToDocumentAsk(row) : "not_current";
}
