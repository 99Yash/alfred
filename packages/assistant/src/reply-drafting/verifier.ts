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
 * Reply-draft verifier (ADR-0098). PURE — no DB, no LLM.
 *
 * The verifier stands between a composed candidate and the `gmail.send_draft`
 * staging call. It checks STRUCTURE, not prose quality: does the reply point at
 * the inbound thread, does every recipient belong to that thread and differ from
 * the user's own mailbox, and does every factual claim rest on a gathered object.
 * Each failing test names a `withheld` reason, and the decision is bound to the
 * exact facts bundle it judged so a later edit cannot inherit a pass.
 *
 * {@link prepareReplyStaging} is the ONLY way a caller obtains a
 * `GmailSendDraftInput` from this module. The composer (#237) therefore cannot
 * stage anything the verifier has not passed — the order is structural, not a
 * convention.
 */

export interface ReplyDraftClaim {
  /** The sentence or fact as it appears in the body. */
  text: string;
  /** The gathered object that grounds it, or `null` when nothing does. */
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
  /** Authoritative address of the mailbox the inbound message arrived in, or null when unknown. */
  mailboxAddress: string | null;
  /** Every address on the inbound thread's From/To/Cc headers, canonical form. */
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

/**
 * Judge one candidate against its context. Tests run in the order of
 * `REPLY_WITHHELD_REASONS`; the first failure is the decision.
 */
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
  if (self) {
    for (const raw of recipients) {
      if (parseEmailAddress(raw) === self) return block("recipient_is_self", raw);
    }
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

/**
 * Run the verifier and, on a pass, build the exact `gmail.send_draft` input
 * the dispatcher accepts. The schema parse is the tool's own, so a candidate
 * the tool would reject fails here rather than at staging time.
 */
export function prepareReplyStaging(
  candidate: ReplyDraftCandidate,
  ctx: ReplyVerifierContext,
): ReplyStagingPlan {
  const verifier = verifyReplyCandidate(candidate, ctx);
  if (verifier.decision === "block") {
    return { kind: "withheld", reason: verifier.reason, detail: verifier.detail ?? null, verifier };
  }
  const input = gmailSendDraftInput.parse({
    to: candidate.recipients.to,
    ...(candidate.recipients.cc.length > 0 ? { cc: candidate.recipients.cc } : {}),
    subject: candidate.subject,
    bodyText: candidate.bodyText,
    // Verified non-null above; the parse keeps the thread anchor on the approval card.
    threadId: candidate.sourceThreadId ?? undefined,
  });
  return { kind: "stage", input, verifier };
}
