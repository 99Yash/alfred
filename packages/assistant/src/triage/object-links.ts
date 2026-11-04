import {
  parseEmailIdentity,
  parseMailbox,
  type GmailEmailInterpretationPayload,
  type ObservationInsertInput,
} from "@alfred/contracts";
import type { Document } from "@alfred/db/schemas";
import { sha256Canonical } from "@alfred/db/hash";
import {
  proposeReconcileCandidates,
  reconcileEvidence,
  type ReconciledObject,
} from "@alfred/assistant/connections";
import { appendObservationFamilyMember } from "../knowledge";

/**
 * The object half of the ADR-0092 `about` observation (ADR-0120 decision 3). Triage links each
 * mail to the things it names one time, so a later reader does not match the mail text again.
 */

const OBJECT_LINKS_REDUCER_VERSION = 1;

/** The same family-key part that `gmail-reducer.ts` uses for a message with no account. */
const UNKNOWN_ACCOUNT_FAMILY_KEY_PART = "unknown-account";

export type MailObjectLinkDocument = Pick<
  Document,
  | "id"
  | "userId"
  | "sourceId"
  | "sourceThreadId"
  | "accountId"
  | "title"
  | "content"
  | "authoredAt"
  | "ingestedAt"
>;

export type MailObjectLinkWrite =
  /** The mail names no key and no provider link. Nothing is written. */
  | { status: "no_link" }
  /**
   * `no_sender`: the From header has no address, so the row has no subject, and nothing is
   * written. `dry`: the caller asked for no write (`commit: false`).
   */
  | {
      status: "inserted" | "deduped" | "dry" | "no_sender";
      resolved: readonly ReconciledObject<"about">[];
    };

/**
 * Propose the keys of one mail, resolve them against the store, and append the
 * `gmail/email_interpretation` row. The reading and the sender gate are the briefing's `about`
 * ones. A changed resolution appends a member that supersedes the head, and the same resolution
 * dedups. Thus a rerun and the backfill are idempotent. It returns the resolution, so a caller
 * does not resolve the same mail two times.
 */
export async function recordMailObjectLinks(args: {
  document: MailObjectLinkDocument;
  /** The raw From header. */
  sender: string | null;
  /** `false` resolves and builds the row but writes nothing, for a dry run. Default `true`. */
  commit?: boolean;
}): Promise<MailObjectLinkWrite> {
  const { document } = args;

  const candidates = proposeReconcileCandidates(
    { id: document.id, text: { subject: document.title ?? "", content: document.content } },
    { reading: "about", sender: args.sender },
  );

  if (!candidates) return { status: "no_link" };

  const reconciled = await reconcileEvidence({ userId: document.userId, subjects: [candidates] });
  const resolved = reconciled.get(document.id) ?? [];
  const senderIdentity = parseEmailIdentity(parseMailbox(args.sender)?.address);

  // The todo ref still reads the resolution.
  if (!senderIdentity) return { status: "no_sender", resolved };

  const objects: GmailEmailInterpretationPayload["objects"] = {
    keys: candidates.keys.map(({ provider, keyKind, keyValue, match }) => ({
      provider,
      keyKind,
      keyValue,
      match,
    })),
    references: (candidates.probe?.references ?? []).map(({ provider, labeled, strong }) => ({
      provider,
      labeled: labeled.map(({ label, value }) => ({ label, value })),
      strong: [...strong],
    })),
    resolved: resolved.map(({ key, state }) => ({
      provider: state.provider,
      kind: state.kind,
      externalId: state.externalId,
      match: key.match,
    })),
  };

  const payload = {
    provider: "gmail",
    documentId: document.id,
    messageId: document.sourceId,
    threadId: document.sourceThreadId,
    accountId: document.accountId,
    objects,
  } satisfies GmailEmailInterpretationPayload;

  const row: ObservationInsertInput = {
    userId: document.userId,
    source: "gmail",
    kind: "email_interpretation",
    // A mail with no `authoredAt` still links; its ingest time is the next best clock.
    occurredAt: document.authoredAt ?? document.ingestedAt,
    familyKey: `gmail:interpretation:${document.accountId ?? UNKNOWN_ACCOUNT_FAMILY_KEY_PART}:${document.sourceId}`,
    evidenceHash: sha256Canonical(objects),
    subjectIdentity: { kind: "email", value: senderIdentity },
    objectIdentity: null,
    payload,
    schemaVersion: 1,
    reducerVersion: OBJECT_LINKS_REDUCER_VERSION,
  };

  if (args.commit === false) return { status: "dry", resolved };

  const result = await appendObservationFamilyMember(row);

  return { status: result.status, resolved };
}
