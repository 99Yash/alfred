import {
  collectProviderLinks,
  isNotificationSender,
  MAX_MAIL_PROVIDER_LINK_VALUE_LENGTH,
  MAX_MAIL_PROVIDER_LINK_VALUES,
  MAX_MAIL_PROVIDER_LINKS,
  parseEmailIdentity,
  parseMailbox,
  type GmailEmailInterpretationPayload,
  type ObservationInsertInput,
  type TriageCategory,
} from "@alfred/contracts";
import type { Document } from "@alfred/db/schemas";
import { sha256Canonical } from "@alfred/db/hash";
import {
  proposeReconcileCandidates,
  reconcileEvidence,
  type ReconcileCandidates,
  type ReconciledObject,
} from "@alfred/assistant/connections";
import { appendObservationFamilyMember, UNKNOWN_ACCOUNT_FAMILY_KEY_PART } from "../knowledge";

/**
 * The object half of the ADR-0092 `about` observation (ADR-0120 decision 3). Triage stores what
 * each mail names one time, so a later reader does not read the mail text again. The row holds the
 * keys and the provider links, not a resolution: a reader resolves them against the store when it
 * reads.
 */

const OBJECT_LINKS_REDUCER_VERSION = 1;

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

/** The stored things that the mail names now, strongest match first. For the todo ref only. */
type MailObjectResolution = readonly ReconciledObject<"about">[];

export type MailObjectLinkProposal =
  /** The mail names no key and no link of its sender. Nothing resolves, and there is no row. */
  | { status: "no_link" }
  /** The From header has no address, so the row has no subject. The resolution still holds. */
  | { status: "no_sender"; resolved: MailObjectResolution }
  /** The row to append with {@link appendMailObjectLink}, and the resolution of its keys now. */
  | { status: "link"; resolved: MailObjectResolution; row: ObservationInsertInput };

type MailObjectLinks = GmailEmailInterpretationPayload["objects"]["links"];

/** One mail to propose for. */
export interface MailObjectLinkInput {
  document: MailObjectLinkDocument;
  /** The raw From header. */
  sender: string | null;
  /** The triage verdict for this message. */
  category: TriageCategory;
}

/** What one mail names, before the resolve. Pure, so a batch resolves all of them in one call. */
interface MailObjectLinkPlan {
  mail: MailObjectLinkInput;
  candidates: ReconcileCandidates<"about"> | null;
  links: MailObjectLinks;
}

/**
 * Propose the keys and the provider links of one mail, and resolve the keys against the store. It
 * writes nothing. The reading and the sender gate are the briefing's `about` ones. The resolution
 * is for the todo ref of the same step; the row does not store it. It is the batch path with one
 * mail, so triage and the backfill share one code path.
 */
export async function proposeMailObjectLinks(
  mail: MailObjectLinkInput,
): Promise<MailObjectLinkProposal> {
  const plan = planMailObjectLinks(mail);

  return finishMailObjectLinks(plan, await resolveMailObjectLinkPlans([plan]));
}

/**
 * {@link proposeMailObjectLinks} for many mails, with one `reconcileEvidence` call for each user
 * in the batch, not one for each mail. The result keeps the input order.
 */
export async function proposeMailObjectLinksBatch(
  mails: readonly MailObjectLinkInput[],
): Promise<{ mail: MailObjectLinkInput; proposal: MailObjectLinkProposal }[]> {
  const plans = mails.map(planMailObjectLinks);
  const resolved = await resolveMailObjectLinkPlans(plans);

  return plans.map((plan) => ({
    mail: plan.mail,
    proposal: finishMailObjectLinks(plan, resolved),
  }));
}

function planMailObjectLinks(mail: MailObjectLinkInput): MailObjectLinkPlan {
  const { document, sender } = mail;
  const subject = document.title ?? "";

  const candidates = proposeReconcileCandidates(
    { id: document.id, text: { subject, content: document.content } },
    { reading: "about", sender },
  );

  // The same text that the identity probe reads, before its label and strength filters.
  const links = storedProviderLinks(`${subject}\n${document.content}`, sender);

  return { mail, candidates, links };
}

/** The resolution of each plan, keyed by document id. One `reconcileEvidence` call for each user. */
async function resolveMailObjectLinkPlans(
  plans: readonly MailObjectLinkPlan[],
): Promise<ReadonlyMap<string, MailObjectResolution>> {
  const subjectsByUser = new Map<string, ReconcileCandidates<"about">[]>();

  for (const { mail, candidates } of plans) {
    if (!candidates) continue;
    const subjects = subjectsByUser.get(mail.document.userId) ?? [];
    subjects.push(candidates);
    subjectsByUser.set(mail.document.userId, subjects);
  }

  const resolved = new Map<string, MailObjectResolution>();

  for (const [userId, subjects] of subjectsByUser) {
    for (const [id, objects] of await reconcileEvidence({ userId, subjects })) {
      resolved.set(id, objects);
    }
  }

  return resolved;
}

function finishMailObjectLinks(
  { mail, candidates, links }: MailObjectLinkPlan,
  resolvedById: ReadonlyMap<string, MailObjectResolution>,
): MailObjectLinkProposal {
  const { document, sender } = mail;

  if (!candidates && links.length === 0) return { status: "no_link" };

  const resolved = resolvedById.get(document.id) ?? [];

  const senderIdentity = parseEmailIdentity(parseMailbox(sender)?.address);

  if (!senderIdentity) return { status: "no_sender", resolved };

  const payload = {
    provider: "gmail",
    documentId: document.id,
    messageId: document.sourceId,
    threadId: document.sourceThreadId,
    accountId: document.accountId,
    category: mail.category,
    objects: {
      keys: (candidates?.keys ?? []).map(({ provider, keyKind, keyValue, match }) => ({
        provider,
        keyKind,
        keyValue,
        match,
      })),
      links,
    },
  } satisfies GmailEmailInterpretationPayload;

  const row: ObservationInsertInput = {
    userId: document.userId,
    source: "gmail",
    kind: "email_interpretation",
    // A mail with no `authoredAt` still links; its ingest time is the next best clock.
    occurredAt: document.authoredAt ?? document.ingestedAt,
    familyKey: `gmail:interpretation:${document.accountId ?? UNKNOWN_ACCOUNT_FAMILY_KEY_PART}:${document.sourceId}`,
    evidenceHash: sha256Canonical(payload),
    subjectIdentity: { kind: "email", value: senderIdentity },
    objectIdentity: null,
    payload,
    schemaVersion: 1,
    reducerVersion: OBJECT_LINKS_REDUCER_VERSION,
  };

  return { status: "link", resolved, row };
}

/**
 * Append the row of a `link` proposal. The family dedups against its head only: the same payload
 * as the head writes nothing, and each other payload becomes the head, also a return to an older
 * one (a category that changes on a re-triage and then changes back). Thus a rerun and the
 * backfill are idempotent, and the head is always the latest reading.
 */
export async function appendMailObjectLink(
  row: ObservationInsertInput,
): Promise<"inserted" | "deduped"> {
  const result = await appendObservationFamilyMember(row, { dedup: "head" });

  return result.status;
}

/**
 * The provider links of the mail as `collectProviderLinks` reads them, for each provider whose
 * notification sender sent the mail (ADR-0120 decision 2: only the service's own mail is a provider
 * fact). Each link keeps every id-like value with its label. Equal values and equal links collapse,
 * and the counts stay inside the payload caps.
 */
function storedProviderLinks(text: string, sender: string | null): MailObjectLinks {
  const links: MailObjectLinks = [];
  const seen = new Set<string>();

  for (const link of collectProviderLinks(text)) {
    if (links.length >= MAX_MAIL_PROVIDER_LINKS) break;

    if (!isNotificationSender(link.provider, sender)) continue;

    const values = [
      ...new Map(
        link.values
          .filter(({ value }) => value.length <= MAX_MAIL_PROVIDER_LINK_VALUE_LENGTH)
          .map(({ label, value }) => [JSON.stringify([label, value]), { label, value }] as const),
      ).values(),
    ].slice(0, MAX_MAIL_PROVIDER_LINK_VALUES);

    const key = JSON.stringify([link.provider, values]);

    if (values.length === 0 || seen.has(key)) continue;
    seen.add(key);
    links.push({ provider: link.provider, values });
  }

  return links;
}
