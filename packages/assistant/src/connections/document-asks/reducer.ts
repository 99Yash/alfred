import {
  documentAskEvidenceSchema,
  documentAskProposalSchema,
  getPath,
  isSentGmailMetadata,
  parseAttachmentContentReferences,
  parseGmailDocumentMetadata,
  type AttachmentContentReference,
  type ContentFormat,
  type DocumentAskEvidence,
  type DocumentAskKind,
  type DocumentAskProposal,
  type DocumentAskStatus,
  type GmailDocumentMetadata,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, type Document, type DocumentAskRow } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  documentAskEvidenceKey,
  projectDocumentAskEvidence,
  type DocumentAskOccurrence,
} from "./evidence";
import { createIfAbsent, readActiveForThread, readById, resolveIfActive } from "./store";

/** Server DTO for one persisted Gmail message, not a duplicate document row shape. */
export interface GmailMessageIdentity {
  accountId: string;
  messageId: string;
  threadId: string;
  authoredAt: Date | null;
  isSent: boolean;
}

export interface OpenDocumentAskInput {
  userId: string;
  identity: GmailMessageIdentity;
  proposal: DocumentAskProposal;
  observedAt: Date;
}

export interface ObserveDocumentAskInput {
  userId: string;
  carrier: GmailMessageIdentity;
  evidence: readonly DocumentAskEvidence[];
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
  | "wrong_account_or_thread"
  | "carrier_not_sent"
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

type PersistedGmailIdentity = GmailMessageIdentity;

type SentCarrier = PersistedGmailIdentity & {
  mediaPending: boolean;
};

type StoredAttachmentRow = Pick<
  Document,
  "id" | "content" | "contentHash" | "title" | "accountId" | "sourceThreadId" | "metadata"
>;

type StoredAttachment = {
  row: StoredAttachmentRow;
  metadata: GmailDocumentMetadata;
  references: AttachmentContentReference[];
};

type AttachmentOccurrence = DocumentAskOccurrence;

type GmailIdentityRead =
  | { kind: "found"; identity: PersistedGmailIdentity }
  | { kind: "missing" }
  | { kind: "malformed" };

type CarrierResolution = {
  resolutions: DocumentAskResolution[];
  reason: DocumentAskNoopReason;
};

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

const gmailMessageIdentitySchema = z
  .object({
    accountId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    authoredAt: z.date().nullable(),
    isSent: z.boolean(),
  })
  .strict();

function publicIdentityIsWellFormed(identity: GmailMessageIdentity): boolean {
  return gmailMessageIdentitySchema.safeParse(identity).success;
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

async function readGmailIdentity(
  userId: string,
  accountId: string,
  messageId: string,
): Promise<GmailIdentityRead> {
  const rows = await db()
    .select({
      sourceId: documents.sourceId,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        eq(documents.accountId, accountId),
        eq(documents.sourceId, messageId),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (!row) return { kind: "missing" };

  const authoredAt = trustedAuthoredAt(row);

  if (
    !row.accountId ||
    !row.sourceId ||
    !row.sourceThreadId ||
    (row.authoredAt !== null && !validDate(row.authoredAt))
  ) {
    return { kind: "malformed" };
  }

  return {
    kind: "found",
    identity: {
      accountId: row.accountId,
      messageId: row.sourceId,
      threadId: row.sourceThreadId,
      authoredAt,
      isSent: isSentGmailMetadata(row.metadata),
    },
  };
}

function crossCheckIdentity(
  supplied: GmailMessageIdentity,
  persisted: PersistedGmailIdentity,
): DocumentAskNoopReason | null {
  if (supplied.accountId !== persisted.accountId || supplied.threadId !== persisted.threadId) {
    return "wrong_account_or_thread";
  }

  // The supplied direction and time are only a shape-checked seed. The
  // persisted row, including its provider timestamp, is the sole authority.
  return null;
}

function toStoredAttachment(row: StoredAttachmentRow): StoredAttachment {
  return {
    row,
    metadata: parseGmailDocumentMetadata(row.metadata),
    references: parseAttachmentContentReferences(row.metadata),
  };
}

function attachmentOccurrences(
  attachment: StoredAttachment,
  carrier: PersistedGmailIdentity,
): AttachmentOccurrence[] {
  const { metadata, references, row } = attachment;
  const occurrences: AttachmentOccurrence[] = [];
  const seen = new Set<string>();

  const add = (occurrence: AttachmentOccurrence): void => {
    const key = [occurrence.attachmentId, occurrence.filename, occurrence.mimeType].join("\u0000");

    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push(occurrence);
  };

  const firstAttachmentId = metadata.attachmentId;

  const firstCarrierMatches =
    metadata.messageId === carrier.messageId &&
    (metadata.accountId ?? row.accountId) === carrier.accountId &&
    (metadata.threadId ?? row.sourceThreadId) === carrier.threadId;

  if (firstCarrierMatches && firstAttachmentId) {
    add({
      attachmentId: firstAttachmentId,
      filename: metadata.filename ?? row.title,
      mimeType: metadata.mimeType ?? null,
    });
  }

  for (const reference of references) {
    if (
      reference.messageId === carrier.messageId &&
      reference.attachmentId.length > 0 &&
      reference.accountId === carrier.accountId &&
      reference.threadId === carrier.threadId
    ) {
      add({
        attachmentId: reference.attachmentId,
        filename: reference.filename,
        mimeType: reference.mimeType ?? null,
      });
    }
  }

  return occurrences;
}

function evidenceFromAttachment(
  attachment: StoredAttachment,
  occurrence: AttachmentOccurrence,
): DocumentAskEvidence | null {
  return projectDocumentAskEvidence({
    documentId: attachment.row.id,
    content: attachment.row.content,
    contentHash: attachment.row.contentHash,
    canonicalFormat: attachment.metadata.format,
    canonicalMimeType: attachment.metadata.mimeType,
    occurrence,
  });
}

async function readAttachmentsForCarriers(
  userId: string,
  carriers: readonly PersistedGmailIdentity[],
): Promise<StoredAttachment[]> {
  if (carriers.length === 0) return [];

  // Canonical rows are user-scoped because content dedup folds across linked
  // Gmail accounts. The exact occurrence check grants evidence authority.
  const rows = await db()
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

  const attachments = rows.map(toStoredAttachment);

  return attachments.filter((attachment) =>
    carriers.some((carrier) => attachmentOccurrences(attachment, carrier).length > 0),
  );
}

async function readSentCarriers(
  userId: string,
  accountId: string,
  threadId: string,
): Promise<SentCarrier[]> {
  const rows = await db()
    .select({
      sourceId: documents.sourceId,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
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
    const authoredAt = trustedAuthoredAt(row);

    if (!row.accountId || !row.sourceId || !row.sourceThreadId || authoredAt === null) return [];

    if (!isSentGmailMetadata(row.metadata)) return [];

    return [
      {
        accountId: row.accountId,
        messageId: row.sourceId,
        threadId: row.sourceThreadId,
        authoredAt,
        isSent: true,
        mediaPending: getPath(row.metadata, "mediaPending") === true,
      },
    ];
  });
}

function sameEvidence(left: DocumentAskEvidence, right: DocumentAskEvidence): boolean {
  return (
    left.attachmentDocumentId === right.attachmentDocumentId &&
    left.attachmentId === right.attachmentId &&
    left.filename === right.filename &&
    left.mimeType === right.mimeType &&
    left.contentHash === right.contentHash &&
    left.format === right.format &&
    left.extraction === right.extraction &&
    left.contentKind === right.contentKind &&
    left.evidence === right.evidence
  );
}

function dedupeEvidence(values: readonly DocumentAskEvidence[]): DocumentAskEvidence[] | null {
  const unique = new Map<string, DocumentAskEvidence>();

  for (const evidence of values) {
    const key = documentAskEvidenceKey(evidence);
    const existing = unique.get(key);

    if (existing && !sameEvidence(existing, evidence)) return null;
    unique.set(key, evidence);
  }

  return [...unique.values()];
}

function evidenceFromAttachments(
  attachments: readonly StoredAttachment[],
  carrier: PersistedGmailIdentity,
): DocumentAskEvidence[] | null {
  const evidence: DocumentAskEvidence[] = [];

  for (const attachment of attachments) {
    for (const occurrence of attachmentOccurrences(attachment, carrier)) {
      const projected = evidenceFromAttachment(attachment, occurrence);

      if (projected) evidence.push(projected);
    }
  }

  return dedupeEvidence(evidence);
}

/** Re-read every trusted occurrence on one carrier; the queue result is only a claim. */
async function readCarrierEvidence(
  userId: string,
  carrier: PersistedGmailIdentity,
): Promise<DocumentAskEvidence[] | null> {
  const attachments = await readAttachmentsForCarriers(userId, [carrier]);

  return evidenceFromAttachments(attachments, carrier);
}

async function validateCarrierEvidence(
  userId: string,
  carrier: PersistedGmailIdentity,
  supplied: readonly DocumentAskEvidence[],
): Promise<DocumentAskEvidence[] | null> {
  const parsed = documentAskEvidenceSchema.array().safeParse(supplied);

  if (!parsed.success) return null;

  const suppliedEvidence = dedupeEvidence(parsed.data);
  const persistedEvidence = await readCarrierEvidence(userId, carrier);

  if (!suppliedEvidence || !persistedEvidence) return null;

  if (suppliedEvidence.length !== persistedEvidence.length) return null;

  const persistedByKey = new Map(
    persistedEvidence.map((evidence) => [documentAskEvidenceKey(evidence), evidence]),
  );

  for (const evidence of suppliedEvidence) {
    const persisted = persistedByKey.get(documentAskEvidenceKey(evidence));

    if (!persisted || !sameEvidence(persisted, evidence)) return null;
  }

  return persistedEvidence;
}

/**
 * Resolve each semantic kind independently across the persisted carrier set.
 * A pending media job is a completion barrier: resolving before every
 * candidate carrier finishes would make the result depend on job order.
 */
type CarrierEvidence = {
  carrier: PersistedGmailIdentity;
  evidence: DocumentAskEvidence[];
};

async function resolvePersistedCarriers(input: {
  userId: string;
  accountId: string;
  threadId: string;
  activeAsks: readonly DocumentAskRow[];
  observedAt: Date;
}): Promise<CarrierResolution> {
  if (input.activeAsks.length === 0) return { resolutions: [], reason: "no_active_ask" };

  const carriers = await readSentCarriers(input.userId, input.accountId, input.threadId);

  const hasPendingOtherCarrier = carriers.some(
    (carrier) =>
      carrier.mediaPending &&
      input.activeAsks.some(
        (ask) =>
          ask.askedAt !== null &&
          carrier.authoredAt !== null &&
          carrier.authoredAt.getTime() > ask.askedAt.getTime(),
      ),
  );

  if (hasPendingOtherCarrier) return { resolutions: [], reason: "multiple_carriers" };

  const attachments = await readAttachmentsForCarriers(input.userId, carriers);
  const positiveCarriers: CarrierEvidence[] = [];

  for (const carrier of carriers) {
    const evidence = evidenceFromAttachments(attachments, carrier);

    if (!evidence) return { resolutions: [], reason: "malformed_source" };

    if (evidence.length > 0) positiveCarriers.push({ carrier, evidence });
  }

  if (positiveCarriers.length === 0) {
    return { resolutions: [], reason: "no_positive_evidence" };
  }

  const resolutions: DocumentAskResolution[] = [];
  let reason: DocumentAskNoopReason = "no_positive_evidence";
  const kinds = new Set(input.activeAsks.map((ask) => ask.requestedKind));

  for (const kind of kinds) {
    const asks = input.activeAsks.filter((ask) => ask.requestedKind === kind);
    const ask = asks[0];

    if (asks.length > 1) {
      reason = "ambiguous_active_asks";
      continue;
    }

    if (!ask?.askedAt) {
      if (ask) reason = "unknown_carrier_time";
      continue;
    }

    const askedAt = ask.askedAt;

    const carrierMatches = positiveCarriers.filter(
      ({ carrier, evidence }) =>
        carrier.authoredAt !== null &&
        carrier.authoredAt.getTime() > askedAt.getTime() &&
        evidence.some((item) => item.contentKind === kind),
    );

    if (carrierMatches.length === 0) continue;

    if (carrierMatches.length > 1) {
      reason = "multiple_carriers";
      continue;
    }

    const carrierMatch = carrierMatches[0];

    const matching =
      carrierMatch?.evidence.filter((evidence) => evidence.contentKind === kind) ?? [];

    if (!carrierMatch) {
      reason = "stale_state";
      continue;
    }

    if (matching.length !== 1) {
      reason = "ambiguous_evidence";
      continue;
    }

    const match = matching[0];

    if (!match || !carrierMatch.carrier.authoredAt) {
      reason = "unknown_carrier_time";
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
    observedAt,
  });

  return resolution.resolutions.filter((resolution) => resolution.askId === ask.id);
}

function openNoop(reason: DocumentAskNoopReason): DocumentAskOpenResult {
  return { kind: "noop", reason };
}

function observeNoop(reason: DocumentAskNoopReason): DocumentAskObserveResult {
  return { kind: "noop", reason };
}

export const documentAskReducer: DocumentAskReducer = {
  async open(input) {
    const proposal = documentAskProposalSchema.safeParse(input.proposal);

    if (
      !proposal.success ||
      !validDate(input.observedAt) ||
      !publicIdentityIsWellFormed(input.identity)
    ) {
      return openNoop("malformed_source");
    }

    const source = await readGmailIdentity(
      input.userId,
      input.identity.accountId,
      input.identity.messageId,
    );

    if (source.kind === "missing") return openNoop("unowned_source");

    if (source.kind === "malformed") return openNoop("malformed_source");

    const identityError = crossCheckIdentity(input.identity, source.identity);

    if (identityError) return openNoop(identityError);

    if (source.identity.isSent) return openNoop("source_not_inbound");

    const opened = await createIfAbsent({
      userId: input.userId,
      accountId: source.identity.accountId,
      sourceMessageId: source.identity.messageId,
      threadId: source.identity.threadId,
      requestedKind: proposal.data.requestedKind,
      askedAt: source.identity.authoredAt,
    });

    if (opened.ask.status === "resolved") {
      return {
        kind: opened.created ? "opened" : "existing",
        askId: opened.ask.id,
        status: opened.ask.status,
        resolutions: [],
      };
    }

    const resolutions = await replayForAsk(opened.ask, input.observedAt);
    const current = await readById(input.userId, opened.ask.id);

    if (!current) return openNoop("stale_state");

    return {
      kind: opened.created ? "opened" : "existing",
      askId: opened.ask.id,
      status: current.status,
      resolutions,
    };
  },

  async observe(input) {
    if (!validDate(input.observedAt) || !publicIdentityIsWellFormed(input.carrier)) {
      return observeNoop("malformed_source");
    }

    const carrier = await readGmailIdentity(
      input.userId,
      input.carrier.accountId,
      input.carrier.messageId,
    );

    if (carrier.kind === "missing") return observeNoop("unowned_source");

    if (carrier.kind === "malformed") return observeNoop("malformed_source");

    const identityError = crossCheckIdentity(input.carrier, carrier.identity);

    if (identityError) return observeNoop(identityError);

    if (!carrier.identity.isSent) return observeNoop("carrier_not_sent");

    const activeAsks = await readActiveForThread(
      input.userId,
      carrier.identity.accountId,
      carrier.identity.threadId,
    );

    if (activeAsks.length === 0) return observeNoop("no_active_ask");

    const evidence = await validateCarrierEvidence(input.userId, carrier.identity, input.evidence);

    if (!evidence) return observeNoop("malformed_source");

    const resolution = await resolvePersistedCarriers({
      userId: input.userId,
      accountId: carrier.identity.accountId,
      threadId: carrier.identity.threadId,
      activeAsks,
      observedAt: input.observedAt,
    });

    return resolution.resolutions.length > 0
      ? { kind: "resolved", resolutions: resolution.resolutions }
      : observeNoop(resolution.reason);
  },
};
