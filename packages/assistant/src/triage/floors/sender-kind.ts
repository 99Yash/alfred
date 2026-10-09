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
 * Sender-kind floor (#210, #218). Nobody writes back to a list or a no-reply
 * address, so `awaiting_reply` from a confident group/service sender goes to `fyi`.
 * `action_needed`/`urgent` need a structural reason. Role boxes (support@) can ask
 * for a reply, so only strong no-reply evidence demotes a service sender.
 * An exact group envelope (`team@`) also loses the reply lane by address alone (#1187).
 * The `unknown` contract is in `docs/reference/triage.md`.
 */
export type SenderKindDemotionFloorContext = {
  signalText?: string;
  /** No subject: a scary task title must not veto a demotion. Falls back to `signalText`. */
  collabVetoText?: string;
  sender?: string | null;
  subject?: string | null;
  to?: string | null;
  cc?: string | null;
  /** Audience half of the alarm gate (#354). Absent means no demotion. */
  accountEmail?: string | null;
  collabActivity?: CollabActivityKind | null;
};

export function applySenderKindDemotionFloor(
  classification: TriageClassification,
  senderKind: Observations["senderKind"],
  context: SenderKindDemotionFloorContext = {},
): FloorResult & { reason: SenderKindDemotionReason | null } {
  // The model says this is directed at the user: veto every demotion below.
  if (context.collabActivity != null && isOwnershipCollabActivity(context.collabActivity)) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  const reason = senderKind ? senderKindDemotionReason(context, senderKind) : null;

  // Group envelope (#1187): exact `GROUP_LOCALS` only; support@/billing@ stay model-decided.
  // Known cost: a staffed `sales@` that asks a question also loses the reply lane.
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

  // GitHub's `ci_activity` Cc alias is the reason header itself, so it needs no
  // projection. `notifications@github.com` has none, and Net B was demoting these alone.
  if (
    !senderKind &&
    isGithubCiActivityNotification(context) &&
    senderKindFloorShouldDemoteCategory(classification.category, "github_passive_pr_or_ci")
  ) {
    return {
      verdict: {
        kind: "demote",
        key: "sender_kind_floor",
        note: "GitHub sent a passive CI notification",
        reason:
          "Sender-kind floor: GitHub CI run notification (ci_activity) is not awaiting the user's action",
      },
      reason: "github_passive_pr_or_ci",
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
 * Which service evidence may demote a demand. Total over {@link ServiceEvidenceCode}:
 * bare literals once let a new code switch this floor off for `noreply.github.com`.
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

/** The whole local part is a group envelope (`team@`). `sam.all@` does not match. */
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

/** Shared with the cold-sender todo gate, so both use one definition of a real stake. */
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
  // The model's collab read beats the body regex (#218). Passive kinds still keep
  // the credential and stake vetoes, with the RECALL predicate.
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

// Not `/issues/N`: an issue can be a real ask; unmerged PR review is not (rule 16b).
const PR_THREAD_RE = /\/pull\/\d+|\bpull request\b|\bpr #\d+\b/i;

const GITHUB_REASON_ALIAS_RE = /<([^>]+@noreply\.github\.com)>/gi;

const GITHUB_CI_ACTIVITY_ALIAS = "ci_activity@noreply.github.com";

const PASSIVE_GITHUB_REASON_ALIASES = new Set([
  "author@noreply.github.com",
  GITHUB_CI_ACTIVITY_ALIAS,
  "state_change@noreply.github.com",
]);

export function isGithubNotificationSender(sender: string | null | undefined): boolean {
  return GITHUB_NOTIFICATION_RE.test(sender ?? "");
}

export function matchesPrThread(text: string): boolean {
  return PR_THREAD_RE.test(text);
}

function isPassiveGithubPrOrCiNotification(context: SenderKindDemotionFloorContext): boolean {
  if (!GITHUB_NOTIFICATION_RE.test(context.sender ?? "")) return false;
  const reasons = githubReasonAliases(context.cc);

  if (!reasons.some((r) => PASSIVE_GITHUB_REASON_ALIASES.has(r))) return false;

  if (reasons.includes(GITHUB_CI_ACTIVITY_ALIAS)) return true;

  return PR_THREAD_RE.test(context.subject ?? "");
}

function isGithubCiActivityNotification(context: SenderKindDemotionFloorContext): boolean {
  return (
    GITHUB_NOTIFICATION_RE.test(context.sender ?? "") &&
    githubReasonAliases(context.cc).includes(GITHUB_CI_ACTIVITY_ALIAS)
  );
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

  // A named leaked credential escapes demotion (#580). Recall predicate: the floor skips passwords.
  if (matchesExposedCredentialClaim(text)) return false;

  return (
    AUTH_SIGNIN_NOTICE_RE.test(text) &&
    AUTH_NO_ACTION_IF_YOU_RE.test(text) &&
    AUTH_UNRECOGNIZED_RE.test(text)
  );
}

// Monitoring alarm (#354): demote only when the shape matches AND the user is not in To/Cc.
// Only SNS is seen in prod; PagerDuty/Grafana/Datadog/Opsgenie are unverified guesses.
const MONITORING_SENDER_RE = /sns\.amazonaws\.com|pagerduty|opsgenie|grafana|datadog/i;

const MONITORING_ALARM_SUBJECT_RE = /^\s*(?:ALARM|ALERT)\b\s*:/i;

function isMonitoringAlarmBroadcast(context: SenderKindDemotionFloorContext): boolean {
  const shaped =
    MONITORING_SENDER_RE.test(context.sender ?? "") ||
    MONITORING_ALARM_SUBJECT_RE.test(context.subject ?? "");

  if (!shaped) return false;
  const signalText = context.signalText ?? "";

  // A leaked credential escapes demotion. Recall predicate: the case names a password.
  if (matchesExposedCredentialClaim(signalText)) return false;

  // No body-prose ownership: list boilerplate is full of "you". No stake veto either:
  // every alarm reads "critical", so it would disable the floor. The audience gate makes this safe.
  return isBroadcastAudience(context);
}

/**
 * True only when the user's address is known and absent from To and Cc. Exact
 * parsed match: a substring test misses `u+alerts@x` and falsely hits `notu@x`.
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
