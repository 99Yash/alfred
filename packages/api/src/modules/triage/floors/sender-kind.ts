import {
  isOwnershipCollabActivity,
  isPassiveCollabActivity,
  type CollabActivityKind,
} from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { truncateRationale } from "../rationale";
import { canonicalizeEmailForMatch, recipientAddresses } from "../sender-context";
import { matchesExposedSecret } from "./override";

export type SenderKindDemotionReason =
  | "collab_state_transition"
  | "collab_passive_activity"
  | "github_passive_pr_or_ci"
  | "broadcast_auth_signin_confirmation"
  | "monitoring_alarm";

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
): {
  classification: TriageClassification;
  demoted: boolean;
  reason: SenderKindDemotionReason | null;
} {
  // An ownership collabActivity is a model-emitted "this is directed at the user"
  // read. Treat it as a veto over every passive sender-kind demotion path,
  // including the broad awaiting_reply demotion and GitHub reason aliases.
  if (context.collabActivity != null && isOwnershipCollabActivity(context.collabActivity)) {
    return { classification, demoted: false, reason: null };
  }

  const reason = senderKind ? senderKindDemotionReason(context, senderKind) : null;
  if (
    !senderKind ||
    !senderKindCanDemoteDemand(senderKind) ||
    !senderKindFloorShouldDemoteCategory(classification.category, reason)
  ) {
    return { classification, demoted: false, reason: null };
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
    classification: {
      ...classification,
      category: "fyi",
      todoSuggestion: null,
      todoDecision: {
        outcome: "no_obligation",
        note: `sender_kind_floor: ${note}`,
      },
      rationale: truncateRationale(
        `${classification.rationale} Sender-kind floor: ${senderKind.kind} sender ` +
          `(active projection confidence=${senderKind.confidence.toFixed(2)}) is not awaiting the ` +
          `user's action — demoted ${classification.category} → fyi (demote, never bury).`,
      ),
    },
    demoted: true,
    reason,
  };
}

function senderKindCanDemoteDemand(senderKind: NonNullable<Observations["senderKind"]>) {
  if (senderKind.kind === "group") return true;
  return senderKind.evidenceCodes.some(
    (code) => code === "email:local:service_strong" || code === "gmail:auto_submitted",
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
  // Passive kinds demote, subject to the SAME secret + intrinsic-stake vetoes the
  // regex path honors (a "someone changed status" line that also names an exposed
  // secret or a past-due invoice keeps its escalation).
  const collab = context.collabActivity;
  if (collab != null) {
    if (isPassiveCollabActivity(collab)) {
      const signalText = context.collabVetoText ?? context.signalText ?? "";
      if (!matchesExposedSecret(signalText) && !COLLAB_INTRINSIC_STAKE_RE.test(signalText)) {
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
  // A leaked-secret alarm must escape demotion entirely — keep the security
  // escalation + any legitimate rotate-now todo (mirrors the collab carve-out).
  if (matchesExposedSecret(signalText)) return false;
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
