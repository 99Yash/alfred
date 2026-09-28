import {
  documentAskProposalSchema,
  getPath,
  isSentGmailMetadata,
  parseAttachmentContentReferences,
  parseGmailDocumentMetadata,
  readGmailAttachmentFirstCarrier,
  type ContentFormat,
  type DocumentAskKind,
  type DocumentAskProposal,
  type DocumentAskStatus,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, type Document, type DocumentAskRow } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  documentAskEvidenceKey,
  projectDocumentAskEvidence,
  type DocumentAskEvidence,
  type DocumentAskOccurrence,
} from "./evidence";
import { createIfAbsent, readActiveForThread, readById, resolveIfActive } from "./store";

/**
 * The account-qualified address of one persisted Gmail message. Gmail message
 * ids are mailbox-scoped, so the account is part of the identity. Callers pass
 * only this locator; direction, thread, time, and attachment evidence are read
 * from the persisted rows, never taken from the caller.
 */
export const gmailMessageLocatorSchema = z
  .object({
    accountId: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict();

export type GmailMessageLocator = z.infer<typeof gmailMessageLocatorSchema>;

export interface OpenDocumentAskInput {
  userId: string;
  source: GmailMessageLocator;
  proposal: DocumentAskProposal;
  observedAt: Date;
}

export interface ObserveDocumentAskInput {
  userId: string;
  carrier: GmailMessageLocator;
  observedAt: Date;
}

export type DocumentAskResolution = {
  askId: string;
  requestedKind: DocumentAskKind;
  carrierMessageId: string;
  attachmentDocumentId: string;
  attachmentId: string;
  contentHash: string;
  format: ContentFormat;
  evidenceSource: "extracted_content";
};

export type DocumentAskOpenResult =
  | {
      kind: "opened" | "existing";
      askId: string;
      status: DocumentAskStatus;
      resolutions: readonly DocumentAskResolution[];
    }
  | { kind: "noop"; reason: DocumentAskNoopReason };

export type DocumentAskObserveResult =
  | { kind: "resolved"; resolutions: readonly DocumentAskResolution[] }
  | { kind: "noop"; reason: DocumentAskNoopReason };

export type DocumentAskNoopReason =
  | "malformed_source"
  | "source_not_inbound"
  | "unowned_source"
  | "unknown_carrier_time"
  | "carrier_not_sent"
  | "carrier_media_pending"
  | "no_active_ask"
  | "no_positive_evidence"
  | "ambiguous_active_asks"
  | "ambiguous_evidence"
  | "multiple_carriers"
  | "stale_state";

export interface DocumentAskReducer {
  open(input: OpenDocumentAskInput): Promise<DocumentAskOpenResult>;
  observe(input: ObserveDocumentAskInput): Promise<DocumentAskObserveResult>;
}

/**
 * How long a sibling carrier's `mediaPending` flag can still change on its
 * own. The realtime poll re-schedules a flagged known message only while the
 * message is inside its `newer_than:5m` window, and a BullMQ media job spends
 * about 75 s on its attempts. The bound adds margin for queue lag. After it, a
 * flag that is still set belongs to a job that nothing re-runs, so it cannot
 * keep an ask live.
 */
const MEDIA_PENDING_SETTLE_MS = 30 * 60 * 1000;

type GmailMessageRow = Pick<
  Document,
  "sourceId" | "accountId" | "sourceThreadId" | "authoredAt" | "metadata"
>;

/** One persisted Gmail mail row, read and validated by this module only. */
type PersistedGmailMessage = GmailMessageLocator & {
  threadId: string;
  authoredAt: Date | null;
  isSent: boolean;
  mediaPending: boolean;
};

type StoredAttachmentRow = Pick<
  Document,
  "id" | "content" | "contentHash" | "title" | "accountId" | "sourceThreadId" | "metadata"
>;

type CarrierEvidence = {
  carrier: PersistedGmailMessage;
  evidence: DocumentAskEvidence[];
};

type CarrierResolution = {
  resolutions: DocumentAskResolution[];
  reason: DocumentAskNoopReason;
};

const gmailMessageColumns = {
  sourceId: documents.sourceId,
  accountId: documents.accountId,
  sourceThreadId: documents.sourceThreadId,
  authoredAt: documents.authoredAt,
  metadata: documents.metadata,
};

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** Prefer Gmail's provider timestamp over the sender-controlled envelope date. */
function trustedAuthoredAt(row: { authoredAt: Date | null; metadata: unknown }): Date | null {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  if (metadata.internalDate) {
    const milliseconds = Number(metadata.internalDate);

    if (Number.isFinite(milliseconds)) {
      const date = new Date(milliseconds);

      return validDate(date) ? date : null;
    }
  }

  return validDate(row.authoredAt) ? row.authoredAt : null;
}

function toPersistedMessage(row: GmailMessageRow): PersistedGmailMessage | null {
  if (
    !row.accountId ||
    !row.sourceId ||
    !row.sourceThreadId ||
    (row.authoredAt !== null && !validDate(row.authoredAt))
  ) {
    return null;
  }

  return {
    accountId: row.accountId,
    messageId: row.sourceId,
    threadId: row.sourceThreadId,
    authoredAt: trustedAuthoredAt(row),
    isSent: isSentGmailMetadata(row.metadata),
    mediaPending: getPath(row.metadata, "mediaPending") === true,
  };
}

async function readGmailMessage(
  userId: string,
  locator: GmailMessageLocator,
): Promise<
  { kind: "found"; message: PersistedGmailMessage } | { kind: "missing" } | { kind: "malformed" }
> {
  const rows = await db()
    .select(gmailMessageColumns)
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        eq(documents.accountId, locator.accountId),
        eq(documents.sourceId, locator.messageId),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (!row) return { kind: "missing" };

  const message = toPersistedMessage(row);

  return message ? { kind: "found", message } : { kind: "malformed" };
}

async function readSentCarriers(
  userId: string,
  accountId: string,
  threadId: string,
): Promise<PersistedGmailMessage[]> {
  const rows = await db()
    .select(gmailMessageColumns)
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        eq(documents.accountId, accountId),
        eq(documents.sourceThreadId, threadId),
      ),
    );

  return rows.flatMap((row) => {
    const message = toPersistedMessage(row);

    return message?.isSent && message.authoredAt !== null ? [message] : [];
  });
}

/** Every occurrence of one stored attachment that this exact carrier sent. */
function attachmentOccurrences(
  row: StoredAttachmentRow,
  carrier: PersistedGmailMessage,
): DocumentAskOccurrence[] {
  const metadata = parseGmailDocumentMetadata(row.metadata);
  const firstCarrier = readGmailAttachmentFirstCarrier(row);
  const occurrences: DocumentAskOccurrence[] = [];

  if (
    firstCarrier.messageId === carrier.messageId &&
    firstCarrier.accountId === carrier.accountId &&
    firstCarrier.threadId === carrier.threadId &&
    firstCarrier.attachmentId
  ) {
    occurrences.push({
      attachmentId: firstCarrier.attachmentId,
      filename: metadata.filename ?? row.title,
      mimeType: metadata.mimeType ?? null,
    });
  }

  for (const reference of parseAttachmentContentReferences(row.metadata)) {
    if (
      reference.messageId === carrier.messageId &&
      reference.attachmentId.length > 0 &&
      reference.accountId === carrier.accountId &&
      reference.threadId === carrier.threadId
    ) {
      occurrences.push({
        attachmentId: reference.attachmentId,
        filename: reference.filename,
        mimeType: reference.mimeType ?? null,
      });
    }
  }

  return occurrences;
}

async function readAttachmentRows(userId: string): Promise<StoredAttachmentRow[]> {
  // Canonical rows are user-scoped because content dedup folds across linked
  // Gmail accounts. The exact occurrence check grants evidence authority.
  return db()
    .select({
      id: documents.id,
      content: documents.content,
      contentHash: documents.contentHash,
      title: documents.title,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
}

/** Positive evidence on one carrier, one entry per stored occurrence. */
function carrierEvidence(
  rows: readonly StoredAttachmentRow[],
  carrier: PersistedGmailMessage,
): DocumentAskEvidence[] {
  const unique = new Map<string, DocumentAskEvidence>();

  for (const row of rows) {
    const metadata = parseGmailDocumentMetadata(row.metadata);

    for (const occurrence of attachmentOccurrences(row, carrier)) {
      const evidence = projectDocumentAskEvidence({
        documentId: row.id,
        content: row.content,
        contentHash: row.contentHash,
        canonicalFormat: metadata.format,
        canonicalMimeType: metadata.mimeType,
        occurrence,
      });

      if (evidence && !unique.has(documentAskEvidenceKey(evidence))) {
        unique.set(documentAskEvidenceKey(evidence), evidence);
      }
    }
  }

  return [...unique.values()];
}

function sentAfter(carrier: PersistedGmailMessage, ask: DocumentAskRow): boolean {
  return (
    ask.askedAt !== null &&
    carrier.authoredAt !== null &&
    carrier.authoredAt.getTime() > ask.askedAt.getTime()
  );
}

/**
 * A sibling carrier whose media job can still finish is a completion barrier:
 * resolving before it settles would make the result depend on job order. The
 * observed carrier is never its own barrier (its job is the one running now),
 * and a flag older than {@link MEDIA_PENDING_SETTLE_MS} belongs to a job that
 * nothing re-runs.
 */
function isOpenMediaBarrier(input: {
  carrier: PersistedGmailMessage;
  observedMessageId: string | null;
  activeAsks: readonly DocumentAskRow[];
  observedAt: Date;
}): boolean {
  const { carrier } = input;

  return (
    carrier.mediaPending &&
    carrier.messageId !== input.observedMessageId &&
    carrier.authoredAt !== null &&
    input.observedAt.getTime() - carrier.authoredAt.getTime() < MEDIA_PENDING_SETTLE_MS &&
    input.activeAsks.some((ask) => sentAfter(carrier, ask))
  );
}

/** Resolve each requested kind independently across the persisted carrier set. */
async function resolvePersistedCarriers(input: {
  userId: string;
  accountId: string;
  threadId: string;
  activeAsks: readonly DocumentAskRow[];
  observedMessageId: string | null;
  observedAt: Date;
}): Promise<CarrierResolution> {
  if (input.activeAsks.length === 0) return { resolutions: [], reason: "no_active_ask" };

  const carriers = await readSentCarriers(input.userId, input.accountId, input.threadId);

  if (carriers.some((carrier) => isOpenMediaBarrier({ ...input, carrier }))) {
    return { resolutions: [], reason: "carrier_media_pending" };
  }

  const attachmentRows = await readAttachmentRows(input.userId);

  const positiveCarriers: CarrierEvidence[] = carriers.flatMap((carrier) => {
    const evidence = carrierEvidence(attachmentRows, carrier);

    return evidence.length > 0 ? [{ carrier, evidence }] : [];
  });

  if (positiveCarriers.length === 0) {
    return { resolutions: [], reason: "no_positive_evidence" };
  }

  const resolutions: DocumentAskResolution[] = [];
  let reason: DocumentAskNoopReason = "no_positive_evidence";
  const kinds = new Set(input.activeAsks.map((ask) => ask.requestedKind));

  for (const kind of kinds) {
    const [ask, ...otherAsks] = input.activeAsks.filter((row) => row.requestedKind === kind);

    if (!ask) continue;

    if (otherAsks.length > 0) {
      reason = "ambiguous_active_asks";
      continue;
    }

    if (!ask.askedAt) {
      reason = "unknown_carrier_time";
      continue;
    }

    const carrierMatches = positiveCarriers.flatMap(({ carrier, evidence }) => {
      const matching = evidence.filter((item) => item.contentKind === kind);

      return sentAfter(carrier, ask) && matching.length > 0 ? [{ carrier, matching }] : [];
    });

    const [carrierMatch, ...otherCarriers] = carrierMatches;

    if (!carrierMatch) continue;

    if (otherCarriers.length > 0) {
      reason = "multiple_carriers";
      continue;
    }

    const [match, ...otherMatches] = carrierMatch.matching;

    if (!match || otherMatches.length > 0) {
      reason = "ambiguous_evidence";
      continue;
    }

    const resolved = await resolveIfActive({
      id: ask.id,
      userId: ask.userId,
      accountId: ask.accountId,
      threadId: ask.threadId,
      sourceMessageId: ask.sourceMessageId,
      requestedKind: kind,
      carrierMessageId: carrierMatch.carrier.messageId,
      attachmentDocumentId: match.attachmentDocumentId,
      attachmentId: match.attachmentId,
      attachmentContentHash: match.contentHash,
      attachmentFormat: match.format,
      observedAt: input.observedAt,
    });

    if (resolved === "not_current") {
      reason = "stale_state";
      continue;
    }

    resolutions.push({
      askId: resolved.id,
      requestedKind: resolved.requestedKind,
      carrierMessageId: resolved.resolvedCarrierMessageId ?? carrierMatch.carrier.messageId,
      attachmentDocumentId: resolved.resolvedAttachmentDocumentId ?? match.attachmentDocumentId,
      attachmentId: resolved.resolvedAttachmentId ?? match.attachmentId,
      contentHash: resolved.resolvedAttachmentContentHash ?? match.contentHash,
      format: resolved.resolvedAttachmentFormat ?? match.format,
      evidenceSource: "extracted_content",
    });
  }

  return { resolutions, reason };
}

async function replayForAsk(
  ask: DocumentAskRow,
  observedAt: Date,
): Promise<readonly DocumentAskResolution[]> {
  if (!ask.askedAt) return [];

  const activeAsks = await readActiveForThread(ask.userId, ask.accountId, ask.threadId);

  const resolution = await resolvePersistedCarriers({
    userId: ask.userId,
    accountId: ask.accountId,
    threadId: ask.threadId,
    activeAsks,
    observedMessageId: null,
    observedAt,
  });

  return resolution.resolutions.filter((resolution) => resolution.askId === ask.id);
}

function noop(reason: DocumentAskNoopReason) {
  return { kind: "noop" as const, reason };
}

export const documentAskReducer: DocumentAskReducer = {
  async open(input) {
    const proposal = documentAskProposalSchema.safeParse(input.proposal);
    const locator = gmailMessageLocatorSchema.safeParse(input.source);

    if (!proposal.success || !locator.success || !validDate(input.observedAt)) {
      return noop("malformed_source");
    }

    const source = await readGmailMessage(input.userId, locator.data);

    if (source.kind === "missing") return noop("unowned_source");

    if (source.kind === "malformed") return noop("malformed_source");

    if (source.message.isSent) return noop("source_not_inbound");

    const opened = await createIfAbsent({
      userId: input.userId,
      accountId: source.message.accountId,
      sourceMessageId: source.message.messageId,
      threadId: source.message.threadId,
      requestedKind: proposal.data.requestedKind,
      askedAt: source.message.authoredAt,
    });

    const kind = opened.created ? "opened" : "existing";

    if (opened.ask.status === "resolved") {
      return { kind, askId: opened.ask.id, status: opened.ask.status, resolutions: [] };
    }

    const resolutions = await replayForAsk(opened.ask, input.observedAt);
    const current = await readById(input.userId, opened.ask.id);

    if (!current) return noop("stale_state");

    return { kind, askId: opened.ask.id, status: current.status, resolutions };
  },

  async observe(input) {
    const locator = gmailMessageLocatorSchema.safeParse(input.carrier);

    if (!locator.success || !validDate(input.observedAt)) return noop("malformed_source");

    const carrier = await readGmailMessage(input.userId, locator.data);

    if (carrier.kind === "missing") return noop("unowned_source");

    if (carrier.kind === "malformed") return noop("malformed_source");

    if (!carrier.message.isSent) return noop("carrier_not_sent");

    const { accountId, threadId, messageId } = carrier.message;
    const activeAsks = await readActiveForThread(input.userId, accountId, threadId);

    if (activeAsks.length === 0) return noop("no_active_ask");

    const resolution = await resolvePersistedCarriers({
      userId: input.userId,
      accountId,
      threadId,
      activeAsks,
      observedMessageId: messageId,
      observedAt: input.observedAt,
    });

    return resolution.resolutions.length > 0
      ? { kind: "resolved", resolutions: resolution.resolutions }
      : noop(resolution.reason);
  },
};
