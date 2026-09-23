import {
  extractEmailAddress,
  isOwnershipCollabActivity,
  isPassiveCollabActivity,
  isServiceEvidenceCode,
  splitEmail,
  type CollabActivityKind,
  type ServiceEvidenceCode,
} from "@alfred/contracts";
import { isExactGroupLocal } from "../../knowledge";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { canonicalizeEmailForMatch, recipientAddresses } from "../sender-context";
import type { FloorResult } from "./floor";
import { matchesExposedCredentialClaim } from "./override";

export type SenderKindDemotionReason =
  | "collab_state_transition"
  | "collab_passive_activity"
  | "github_passive_pr_or_ci"
  | "broadcast_auth_signin_confirmation"
  | "monitoring_alarm"
  | "group_envelope_reply_lane";

/**
 * Sender-kind demotion floor (#210, on the #218 activated projection). A
 * confident `group` sender or no-reply/bot-shaped `service` sender is not a
 * person the user owes a reply to — you do not write back to a distribution
 * list or a `noreply`/bot address — so `awaiting_reply` from one is
 * definitionally wrong. Demote it to `fyi`:
 * DEMOTE, NEVER BURY (#210 asymmetry) — the thread stays visible, it just leaves
 * the demanding lane.
 *
 * `awaiting_reply` is the zero-bury-risk case and is always demoted for a
 * confident sender kind. `action_needed`/`urgent` require a narrow structural
 * reason: passive collaboration state transitions, passive GitHub PR/CI
 * notifications, group-broadcast sign-in confirmations where the body also says
 * no action is needed if the sign-in was recognized, or monitoring-alarm
 * broadcasts (CloudWatch/SNS-style) fanned out to a distribution address the user
 * is not a direct recipient of (#354 — shape AND audience, never shape alone).
 *
 * `senderKind` is non-null ONLY for a confident group/service — `resolveSenderKind`
 * already gates kind ∈ {group,service} AND confidence >=
 * `TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD`. Service senders get one extra
 * precision gate here: role mailboxes like support@/billing@ can legitimately
 * ask for a reply, while strong no-reply/notification or auto-submitted
 * evidence cannot. PURE.
 *
 * Envelope bar (#1187): an EXACT whole-local `GROUP_LOCALS` sender (`team@`,
 * `all@`, …) holds no reply lane even with no projection signal — the parser
 * types exact members `unknown` (an exact group envelope beats a display name
 * there too), so the signal path above never fires for them. Same demotion,
 * same floor, no new burying. Exact on purpose: infix shapes (`dev.patel@`,
 * `hr.priya@`, `sam.all@`, `jane.team@`, `ops-lead@`) read `person` in the
 * parser and stay model-decided here.
 *
 * `unknown` contract (#1187): the signal path above needs a CONFIDENT kind, so
 * `unknown` — bare single-token locals (`arjun@`), staffed role boxes
 * (`hello@`, `contact@`, `info@`, `support@`, `billing@`) — keeps the model's
 * category there. The envelope bar below is address-based, not kind-based: it
 * reads only the local part, so it demotes a `person`-typed sender too when
 * the address is an exact group envelope. The other floors never branch on the
 * sender kind (`override` escalates on secret claims, `spam` on the Gmail-filed
 * flag, `meeting` on subject/content shape), and rule 8a's
 * deterministic-service second pass (`classify.ts`) is gated on
 * `effectiveAuthor='service'`, so `unknown` stays model-decided in all of
 * them. The full contract lives in `docs/reference/triage.md`.
 */
export type SenderKindDemotionFloorContext = {
  signalText?: string;
  /**
   * Body/snippet text used for collabActivity intrinsic-stake vetoes. Task-tracker
   * subjects are often imperative task titles, not ownership/evidence; scanning
   * them for "critical"/"security"/"payment" would let passive activity on a
   * scary-named task escape demotion. Absent → falls back to signalText for tests
   * and legacy callers.
   */
  collabVetoText?: string;
  sender?: string | null;
  subject?: string | null;
  to?: string | null;
  cc?: string | null;
  /**
   * The connected account's own address (the user being triaged). The AUDIENCE
   * half of the monitoring-alarm gate (#354): a broadcast the user is not a
   * direct recipient of is not their personal action. Absent → the audience gate
   * is a conservative no-op (we cannot prove a broadcast, so we do not demote).
   */
  accountEmail?: string | null;
  /**
   * The cheap model's collaboration-tool activity read (#218). Present only for
   * task/issue-tracker and doc-comment notifications; passive kinds drive the
   * `collab_passive_activity` reason, ownership kinds keep the category. Absent
   * → the model saw no collaboration activity, so the body-regex path applies.
   */
  collabActivity?: CollabActivityKind | null;
};

export function applySenderKindDemotionFloor(
  classification: TriageClassification,
  senderKind: Observations["senderKind"],
  context: SenderKindDemotionFloorContext = {},
): FloorResult & { reason: SenderKindDemotionReason | null } {
  // An ownership collabActivity is a model-emitted "this is directed at the user"
  // read. Treat it as a veto over every passive sender-kind demotion path,
  // including the broad awaiting_reply demotion and GitHub reason aliases.
  if (context.collabActivity != null && isOwnershipCollabActivity(context.collabActivity)) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  const reason = senderKind ? senderKindDemotionReason(context, senderKind) : null;

  // Group-envelope bar (#1187): an exact `GROUP_LOCALS` address holds no reply
  // lane, with or without a confident projection. The parser types exact
  // members `unknown` — an exact group envelope beats a display name there
  // too — so the signal path above never fires for them; this envelope read
  // is the floor that does, and it demotes by address alone (a `person`-typed
  // sender on an exact group address demotes just the same). Scoped
  // to the single-homed {@link isExactGroupLocal} set: role mailboxes outside
  // it (`support@`, `billing@`, `hello@`, `contact@`, `info@`) can legitimately
  // ask for a reply and stay model-decided. That narrows AC2 to the measured
  // set on purpose: the 16-lane prod sample shows zero rows from those
  // senders, so demoting them would trade a measured miss for unmeasured false
  // demotions. Runs after the ownership veto above: an explicit model read
  // that the mail is directed at the user beats the envelope. Known exposure:
  // the staffed exact members (`sales@`, `hr@`, `finance@`, `people@`, `ops@`,
  // `dev@`) demote here too, display-named or bare — a vendor's staffed
  // `sales@` reply that asks a question loses the reply lane. The measured
  // evidence does not answer whether that cost is acceptable, and the set
  // membership stands.
  if (
    (classification.category === "awaiting_reply" || classification.category === "follow_up") &&
    isGroupEnvelopeSender(context.sender)
  ) {
    return {
      verdict: {
        kind: "demote",
        key: "sender_kind_floor",
        note: "group-envelope sender holds no reply lane",
        reason:
          "Sender-kind floor: group-envelope sender (team@-class address) is not owed a reply",
      },
      reason: "group_envelope_reply_lane",
    };
  }

  if (
    !senderKind ||
    !senderKindCanDemoteDemand(senderKind) ||
    !senderKindFloorShouldDemoteCategory(classification.category, reason)
  ) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  const note =
    classification.category === "awaiting_reply"
      ? `${senderKind.kind} sender is not awaiting a reply`
      : reason === "github_passive_pr_or_ci"
        ? `${senderKind.kind} sender sent a passive GitHub PR/CI notification`
        : reason === "broadcast_auth_signin_confirmation"
          ? `${senderKind.kind} sender sent a broadcast sign-in confirmation`
          : reason === "monitoring_alarm"
            ? `${senderKind.kind} sender broadcast a monitoring alarm the user was not addressed on`
            : reason === "collab_passive_activity"
              ? `${senderKind.kind} sender sent passive collaboration activity not directed at the user`
              : `${senderKind.kind} sender sent a passive collaboration state transition`;

  return {
    verdict: {
      kind: "demote",
      key: "sender_kind_floor",
      note,
      reason:
        `Sender-kind floor: ${senderKind.kind} sender ` +
        `(active projection confidence=${senderKind.confidence.toFixed(2)}) is not awaiting the ` +
        `user's action`,
    },
    reason,
  };
}

/**
 * Which `service` evidence codes are precise enough to demote a demanding
 * thread. A role mailbox (`support@`, `billing@`) can legitimately ask for a
 * reply, so it may not; a no-reply address, a no-reply HOST and an
 * auto-submitted envelope cannot be replied to at all, so they may.
 *
 * TOTAL over {@link ServiceEvidenceCode}, not a pair of bare literals. The
 * vocabulary is minted by the #218 kind classifier in
 * `packages/assistant/src/knowledge/entity-kind-classifier.ts`, persisted into
 * the projection this floor reads, and answered a SECOND time there by
 * `HARD_SERVICE_EVIDENCE` for a different question (may this refuse a live
 * send). The two answers differ on purpose. Sharing one union is what makes
 * them move together: the bare-literal form let a new member —
 * `email:domain:service_strong` — land in the classifier and silently switch
 * this floor off for every `noreply.github.com` thread.
 */
const SERVICE_EVIDENCE_CAN_DEMOTE_DEMAND = {
  "email:local:service_strong": true,
  "email:domain:service_strong": true,
  "email:local:service": false,
  "gmail:auto_submitted": true,
} satisfies Record<ServiceEvidenceCode, boolean>;

function senderKindCanDemoteDemand(senderKind: NonNullable<Observations["senderKind"]>) {
  if (senderKind.kind === "group") return true;

  return senderKind.evidenceCodes.some(
    (code) => isServiceEvidenceCode(code) && SERVICE_EVIDENCE_CAN_DEMOTE_DEMAND[code],
  );
}

function senderKindFloorShouldDemoteCategory(
  category: TriageClassification["category"],
  reason: SenderKindDemotionReason | null,
): boolean {
  if (category === "awaiting_reply") return true;

  if (category === "urgent") {
    return reason === "broadcast_auth_signin_confirmation" || reason === "monitoring_alarm";
  }

  if (category !== "action_needed") return false;

  return reason !== null;
}

/**
 * Envelope half of the group bar (#1187): true when the sender parses to an
 * address whose whole local part is a group envelope (`team@`, `all@`, …). The
 * set is single-homed as {@link isExactGroupLocal} — no infix pattern, so
 * `dev.patel@` and `sam.all@` do not match; address extraction and the split
 * reuse the contracts helpers so this floor states no email grammar of its
 * own. A bare `From` with no parseable address is a conservative no.
 */
function isGroupEnvelopeSender(sender: string | null | undefined): boolean {
  const address = extractEmailAddress(sender);
  const split = address ? splitEmail(address) : null;

  return split ? isExactGroupLocal(split.localPart) : false;
}

const COLLAB_STATE_TRANSITION_RE =
  /\b(?:changed status|set the status to|moved (?:task )?(?:to|from)|marked (?:as )?(?:done|complete|completed|resolved|closed)|status changed|re-?opened|closed task)\b/i;

const COLLAB_DIRECT_OWNERSHIP_RE =
  /\b(?:assigned (?:task )?to you|assigned you\b|you were assigned|mentioned you|can you|could you|please|pls\s+merge|review and merge|pick this up)\b/i;

const COLLAB_INTRINSIC_STAKE_RE =
  /\b(?:payment failed|card declined|invoice due|past due|access (?:will be )?(?:disabled|suspended|lost)|security|compromis|exposed|leaked|secret|token|api[ -]?key|private key|production outage|prod outage|blocked deploy|critical)\b/i;

/**
 * True when the text names a real intrinsic stake (money owed/at-risk, access
 * loss, security exposure, a production outage/blocked deploy). Shared with the
 * rail's cold-sender carve-out so the floor and the todo gate honor ONE
 * intrinsic-stake definition. PURE.
 */
export function matchesCollabIntrinsicStake(text: string): boolean {
  return COLLAB_INTRINSIC_STAKE_RE.test(text);
}

function isPassiveCollaborationStateTransition(signalText: string): boolean {
  return (
    COLLAB_STATE_TRANSITION_RE.test(signalText) &&
    !COLLAB_DIRECT_OWNERSHIP_RE.test(signalText) &&
    !COLLAB_INTRINSIC_STAKE_RE.test(signalText)
  );
}

function senderKindDemotionReason(
  context: SenderKindDemotionFloorContext,
  senderKind: NonNullable<Observations["senderKind"]>,
): SenderKindDemotionReason | null {
  // Model-authoritative collaboration signal (#218). When the cheap model tagged
  // the notification's activity kind, it is a stronger, per-message read than the
  // body-regex heuristic — so it takes precedence over `collab_state_transition`.
  // Ownership kinds are handled as a hard veto in `applySenderKindDemotionFloor`.
  // Passive kinds demote, subject to the SAME credential + intrinsic-stake vetoes
  // the regex path honors (a "someone changed status" line that also names an
  // exposed credential or a past-due invoice keeps its escalation). The veto uses
  // the RECALL predicate — `password` included — because it only PRESERVES what
  // the model chose; the precision predicate belongs to the escalating floor.
  const collab = context.collabActivity;

  if (collab != null) {
    if (isPassiveCollabActivity(collab)) {
      const signalText = context.collabVetoText ?? context.signalText ?? "";

      if (
        !matchesExposedCredentialClaim(signalText) &&
        !COLLAB_INTRINSIC_STAKE_RE.test(signalText)
      ) {
        return "collab_passive_activity";
      }
    }
  } else if (isPassiveCollaborationStateTransition(context.signalText ?? "")) {
    return "collab_state_transition";
  }

  if (isPassiveGithubPrOrCiNotification(context)) return "github_passive_pr_or_ci";

  if (isBroadcastAuthSignInConfirmation(context, senderKind)) {
    return "broadcast_auth_signin_confirmation";
  }

  if (isMonitoringAlarmBroadcast(context)) return "monitoring_alarm";

  return null;
}

const GITHUB_NOTIFICATION_RE = /notifications@github\.com/i;

// A GitHub PR-notification thread: the body carries a `/pull/N` link and the
// subject a `(PR #N)` ref. `/issues/N` and issue refs deliberately don't match —
// an issue can be a real ask; review of unmerged PR code is not (rule 16b).
const PR_THREAD_RE = /\/pull\/\d+|\bpull request\b|\bpr #\d+\b/i;

const GITHUB_REASON_ALIAS_RE = /<([^>]+@noreply\.github\.com)>/gi;

const PASSIVE_GITHUB_REASON_ALIASES = new Set([
  "author@noreply.github.com",
  "ci_activity@noreply.github.com",
  "state_change@noreply.github.com",
]);

/** True when the sender is GitHub's notification address. Shared with the rail's PR gate. PURE. */
export function isGithubNotificationSender(sender: string | null | undefined): boolean {
  return GITHUB_NOTIFICATION_RE.test(sender ?? "");
}

/** True when the text is shaped like a GitHub pull-request thread. Shared with the rail's PR gate. PURE. */
export function matchesPrThread(text: string): boolean {
  return PR_THREAD_RE.test(text);
}

function isPassiveGithubPrOrCiNotification(context: SenderKindDemotionFloorContext): boolean {
  if (!GITHUB_NOTIFICATION_RE.test(context.sender ?? "")) return false;
  const reasons = githubReasonAliases(context.cc);

  if (!reasons.some((r) => PASSIVE_GITHUB_REASON_ALIASES.has(r))) return false;

  if (reasons.includes("ci_activity@noreply.github.com")) return true;

  return PR_THREAD_RE.test(context.subject ?? "");
}

function githubReasonAliases(cc: string | null | undefined): string[] {
  return [...String(cc ?? "").matchAll(GITHUB_REASON_ALIAS_RE)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
}

const AUTH_SIGNIN_NOTICE_RE = /\b(?:new sign-?in|new login|new sign in|new device sign-?in)\b/i;

const AUTH_NO_ACTION_IF_YOU_RE = /\bif this was you,\s*no action is needed\b/i;

const AUTH_UNRECOGNIZED_RE = /\b(?:if you (?:do not|don't) recognize|if this wasn't you)\b/i;

function isBroadcastAuthSignInConfirmation(
  context: SenderKindDemotionFloorContext,
  senderKind: NonNullable<Observations["senderKind"]>,
): boolean {
  if (senderKind.kind !== "group") return false;
  const text = [context.subject, context.signalText].filter(Boolean).join("\n");

  // A sign-in notice that also names a leaked credential must escape demotion,
  // the same veto `collab_passive_activity` and `monitoring_alarm` carry (#580).
  // Otherwise an `urgent` — the override floor's, or the model's own under rule
  // 15b — is demoted straight back to `fyi` and the rotate-now todo it protects
  // is cleared. Recall predicate, deliberately: since #1188 the floor no longer
  // fires on a user password, so on that noun the model's judgment is the ONLY
  // thing this veto has left to protect.
  if (matchesExposedCredentialClaim(text)) return false;

  return (
    AUTH_SIGNIN_NOTICE_RE.test(text) &&
    AUTH_NO_ACTION_IF_YOU_RE.test(text) &&
    AUTH_UNRECOGNIZED_RE.test(text)
  );
}

// A monitoring/alarm broadcast (#354). CloudWatch/SNS-style alarms fan out to a
// team address the user is not a direct recipient of — a team FYI, not the user's
// personal urgent/action_needed. The cheap model reliably reads the alarming body
// as demanding; the floor demotes it to fyi (visible, never buried) ONLY when the
// SHAPE is a monitoring alarm AND the AUDIENCE is broadcast (`isBroadcastAudience`:
// the user is not in To/Cc — broader than a literal distribution address; an alarm
// To a single other individual also qualifies). Shape alone is not enough: an alarm
// the user is directly To/Cc'd on (they own it, or are on-call for it) keeps its
// category (ADR-0066 audience gate).
//
// Only the AWS SNS `group`-classified case is observed in prod. CloudWatch itself is
// delivered VIA SNS (`no-reply@sns.amazonaws.com` + an `ALARM:` subject), so the SNS
// sender + subject tokens already cover it; PagerDuty/Grafana/Datadog/Opsgenie are a
// HYPOTHESIS — they only fire if `resolveSenderKind` confidently tags them group/
// service, and are unverified against real mail.
const MONITORING_SENDER_RE = /sns\.amazonaws\.com|pagerduty|opsgenie|grafana|datadog/i;

const MONITORING_ALARM_SUBJECT_RE = /^\s*(?:ALARM|ALERT)\b\s*:/i;

function isMonitoringAlarmBroadcast(context: SenderKindDemotionFloorContext): boolean {
  const shaped =
    MONITORING_SENDER_RE.test(context.sender ?? "") ||
    MONITORING_ALARM_SUBJECT_RE.test(context.subject ?? "");

  if (!shaped) return false;
  const signalText = context.signalText ?? "";

  // A leaked-credential alarm must escape demotion entirely — keep the security
  // escalation + any legitimate rotate-now todo (mirrors the collab carve-out).
  // Recall predicate: a broadcast "the production database password was exposed
  // in a public bucket" is the canonical case, and it names a password.
  if (matchesExposedCredentialClaim(signalText)) return false;

  // Do not infer ownership from body prose here. Monitoring/list mail is wrapped
  // in provider and distribution-list boilerplate, so generic second-person or
  // request language is not reliable evidence that THIS user owns the alarm.
  // This interim floor only claims the deterministic envelope fact below: a user
  // directly present in To/Cc keeps the model's category; a provable broadcast is
  // demoted. Role/object ownership belongs to the ADR-0066/0067 user-context
  // consumer, not another alarm-specific phrase vocabulary.
  // DELIBERATE ASYMMETRY with the collaboration path: we do NOT honor
  // COLLAB_INTRINSIC_STAKE_RE here. Every alarm body reads as threshold-crossing /
  // "critical" / "outage" by construction, so an intrinsic-stake veto would neuter
  // the floor entirely. The audience gate is what makes this safe: a genuine SEV1
  // the user is not To/Cc'd on is a team FYI, not their personal urgent — and it
  // still renders (demote to fyi, never bury). A SEV1 that IS the user's own is
  // caught by the ownership veto above or by them being a direct recipient below.
  return isBroadcastAudience(context);
}

/**
 * The audience half of the monitoring-alarm gate: true only when we can PROVE the
 * user was not a direct recipient — the connected account's own address is known
 * AND absent from both To and Cc. Missing identity or missing recipient headers
 * are conservative no-ops (we cannot prove a broadcast, so we do not demote). A
 * user in Cc counts as directly addressed. PURE.
 *
 * Membership is by EXACT parsed address, not raw-header substring: a substring
 * test over-demotes a user addressed via a Gmail plus-tag (`u+alerts@x` does not
 * contain `u@x`) and under-demotes on an incidental substring (`u@x` inside
 * `notu@x`). `recipientAddresses` parses each To/Cc token and folds the plus-tag,
 * so a plus-addressed direct recipient still counts as addressed.
 */
function isBroadcastAudience(context: SenderKindDemotionFloorContext): boolean {
  const account = canonicalizeEmailForMatch(context.accountEmail);

  if (!account) return false;
  const to = context.to ?? "";
  const cc = context.cc ?? "";

  if (!to.trim() && !cc.trim()) return false;
  const addressed = new Set([...recipientAddresses(to), ...recipientAddresses(cc)]);

  return !addressed.has(account);
}
