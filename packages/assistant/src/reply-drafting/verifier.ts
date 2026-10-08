import {
  gmailSendDraftInput,
  parseEmailAddress,
  type GmailSendDraftInput,
  type ReplyDraftGatheredObject,
  type ReplyDraftStyleSelection,
  type ReplyDraftVerifierBinding,
  type ReplyDraftVerifierDecision,
  type ReplyWithheldReason,
} from "@alfred/contracts";

/**
 * Reply-draft verifier (ADR-0098). Pure: no DB, no LLM.
 * Checks structure, not prose: the reply targets the inbound thread, recipients are on it
 * and are not the user, and each claim rests on a gathered object. The first failure names
 * the `withheld` reason. A pass is bound to the exact facts it judged.
 * {@link prepareReplyStaging} is the only way to get a `GmailSendDraftInput` here.
 */

export interface ReplyDraftClaim {
  /** As it appears in the body. */
  text: string;
  /** `null` when nothing grounds it. */
  source: ReplyDraftGatheredObject | null;
}

export interface ReplyDraftCandidate {
  sourceThreadId: string | null;
  recipients: { to: string[]; cc: string[] };
  subject: string;
  bodyText: string;
  claims: ReplyDraftClaim[];
}

export interface ReplyVerifierContext {
  /** Null when unknown. */
  mailboxAddress: string | null;
  /** From/To/Cc of the inbound thread, canonical. */
  threadParticipants: string[];
  style: ReplyDraftStyleSelection;
  featureFlagEnabled: boolean;
}

export type ReplyStagingPlan =
  | { kind: "stage"; input: GmailSendDraftInput; verifier: ReplyDraftVerifierDecision }
  | {
      kind: "withheld";
      reason: ReplyWithheldReason;
      detail: string | null;
      verifier: ReplyDraftVerifierDecision;
    };

function bindingFor(
  candidate: ReplyDraftCandidate,
  ctx: ReplyVerifierContext,
): ReplyDraftVerifierBinding {
  return {
    sourceThreadId: candidate.sourceThreadId,
    recipients: [...candidate.recipients.to, ...candidate.recipients.cc],
    claimCount: candidate.claims.length,
    style: ctx.style,
    featureFlagEnabled: ctx.featureFlagEnabled,
  };
}

function canonicalSet(addresses: readonly string[]): Set<string> {
  const out = new Set<string>();

  for (const raw of addresses) {
    const parsed = parseEmailAddress(raw);

    if (parsed) out.add(parsed);
  }

  return out;
}

/** Tests run in `REPLY_WITHHELD_REASONS` order; the first failure decides. */
export function verifyReplyCandidate(
  candidate: ReplyDraftCandidate,
  ctx: ReplyVerifierContext,
): ReplyDraftVerifierDecision {
  const boundTo = bindingFor(candidate, ctx);

  const block = (reason: ReplyWithheldReason, detail?: string): ReplyDraftVerifierDecision => ({
    decision: "block",
    reason,
    boundTo,
    ...(detail === undefined ? {} : { detail }),
  });

  if (!candidate.sourceThreadId) return block("missing_thread_id");

  const recipients = [...candidate.recipients.to, ...candidate.recipients.cc];

  if (candidate.recipients.to.length === 0) return block("missing_recipient");

  for (const raw of recipients) {
    if (!parseEmailAddress(raw)) return block("missing_recipient", raw);
  }

  const self = parseEmailAddress(ctx.mailboxAddress);

  if (!self) return block("context_mismatch", "The inbound mailbox address is unknown.");

  for (const raw of recipients) {
    if (parseEmailAddress(raw) === self) return block("recipient_is_self", raw);
  }

  const participants = canonicalSet(ctx.threadParticipants);

  for (const raw of recipients) {
    const canonical = parseEmailAddress(raw);

    if (canonical && !participants.has(canonical)) return block("recipient_not_in_thread", raw);
  }

  for (const claim of candidate.claims) {
    if (!claim.source || claim.source.status !== "resolved") {
      return block("unsupported_claim", claim.text);
    }
  }

  if (candidate.bodyText.trim().length === 0) return block("empty_body");

  return { decision: "pass", boundTo };
}

/** On a pass, build the `gmail.send_draft` input with the tool's own schema, so a bad one fails here. */
export function prepareReplyStaging(
  candidate: ReplyDraftCandidate,
  ctx: ReplyVerifierContext,
): ReplyStagingPlan {
  const verifier = verifyReplyCandidate(candidate, ctx);

  if (verifier.decision === "block") {
    return { kind: "withheld", reason: verifier.reason, detail: verifier.detail ?? null, verifier };
  }

  const parsed = gmailSendDraftInput.safeParse({
    to: candidate.recipients.to,
    ...(candidate.recipients.cc.length > 0 ? { cc: candidate.recipients.cc } : {}),
    subject: candidate.subject,
    bodyText: candidate.bodyText,
    // Checked above; keeps the thread on the approval card.
    threadId: candidate.sourceThreadId ?? undefined,
  });

  if (!parsed.success) {
    const blocked: ReplyDraftVerifierDecision = {
      decision: "block",
      reason: "invalid_candidate",
      boundTo: verifier.boundTo,
    };

    return { kind: "withheld", reason: "invalid_candidate", detail: null, verifier: blocked };
  }

  return { kind: "stage", input: parsed.data, verifier };
}
