import {
  isPassiveCollabActivity,
  type CollabActivityKind,
  type SenderContext,
} from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { truncateRationale } from "../rationale";

/**
 * Meeting-gate demotion floor. `meeting` is the highest-precedence category
 * (rule 10) and the ONLY demand lane the sender-kind floor never covers, so a
 * false meeting rides entirely on cheap-model judgment — and it leaks on a few
 * recurring shapes the model reads as "meeting" from the words alone:
 *
 *   - `meeting_recap`  — notes/minutes/recap/summary of a meeting that ALREADY
 *                        happened. Not something to attend or schedule → fyi.
 *   - `meeting_prep`   — a pre-meeting prep / agenda brief. A document about a
 *                        meeting, not a calendar action → fyi.
 *   - `automated_relay`— an automated product/task-tracker (ClickUp/Linear/…)
 *                        notification that merely MENTIONS meeting language
 *                        (the "@everyone offsite in Aug" ClickUp comment). A
 *                        real calendar meeting arrives from a person organizer
 *                        or as a calendar invite, never as a notification relay.
 *   - `investor_notice`— an AGM / shareholder / proxy / e-voting / registrar
 *                        notice (rule 9 already says a corporate "meeting" is
 *                        not the user's meeting) → fyi.
 *   - `public_event`   — a webinar / conference / keynote / summit / launch /
 *                        "save the date" blast (rule 8: public events are not
 *                        the user's calendar meeting) → fyi.
 *
 * Keys on CONTENT SHAPE (subject regex) for the recap/prep pair — the reliable
 * signal, since the automated meeting-assistant senders that emit these parse as
 * `person` (no `noreply`/`notifications` envelope) and carry no projection kind.
 * The `automated_relay` trigger keys on a passive `collabActivity` read from
 * the cheap model. Sender shape alone is deliberately too broad: real Calendar
 * mail also comes from service/no-reply addresses. `investor_notice`/`public_event`
 * key on the deterministic content flags Alfred already computes. All are
 * carved out by the calendar-action subject shape so a real Google-Calendar
 * "Invitation:"/"Proposed new time:"/"starts in 10 minutes" subject is preserved,
 * even one that mentions the event topic in its body.
 *
 * DEMOTE, NEVER BURY (#210 asymmetry) — demoted to `fyi` (still visible), with
 * the stray todo the model minted from the same misread cleared. PURE.
 */
export type MeetingDemotionReason =
  | "meeting_recap"
  | "meeting_prep"
  | "automated_relay"
  | "investor_notice"
  | "public_event";

// Subject shapes. Anchored at the start so a mid-body mention ("see the meeting
// notes") never trips them — only a subject that IS a recap/prep does.
const MEETING_RECAP_SUBJECT_RE =
  /^\s*(?:re:\s*|fwd:\s*)*(?:meeting\s+(?:notes|minutes|recap|summary)|notes\s+from\b|minutes\s+(?:from|of)\b|recap\s+of\b|recap:|post[- ]?meet(?:ing)?\s+summary)/i;
const MEETING_PREP_SUBJECT_RE =
  /^\s*(?:\[[^\]]*\]\s*)*(?:meeting\s+prep\b|prep\s+for\b|agenda\s+for\b|pre[- ]?read\s+for\b)/i;
// Google-Calendar action subject shapes — the carve-out that keeps genuine
// invite/schedule/attendance mail from a service/no-reply calendar address in
// `meeting`.
const CALENDAR_ACTION_SUBJECT_RE =
  /^\s*(?:re:\s*)?(?:(?:updated\s+)?invitation(?:\s+with\s+note)?|proposed\s+new\s+time|new\s+time\s+proposed|(?:cancelled|canceled)(?:\s+event)?|accepted|declined|tentatively\s+accepted|this\s+event\s+has\s+been\s+(?:updated|cancelled|canceled)|reminder:?\s+.*\bstarts\s+in\b)\b|\binvitation:/i;

export function applyMeetingDemotionFloor(
  classification: TriageClassification,
  context: {
    effectiveAuthor?: SenderContext["effectiveAuthor"] | null;
    senderKind?: Observations["senderKind"];
    subject?: string | null;
    collabActivity?: CollabActivityKind | null;
    /** Deterministic content flags (rules 8/9 backstops); optional for callers/tests. */
    contentFlags?: Pick<Observations["content"], "hasInvestorNotice" | "hasPublicEventLanguage">;
  },
): {
  classification: TriageClassification;
  demoted: boolean;
  reason: MeetingDemotionReason | null;
} {
  if (classification.category !== "meeting") {
    return { classification, demoted: false, reason: null };
  }
  const subject = context.subject ?? "";
  // The calendar-action subject shape is the single carve-out shared by every
  // trigger: a genuine "Invitation:"/"Proposed new time:" stays `meeting` even
  // when it comes from a service or mentions the event topic in its body.
  const isCalendarAction = CALENDAR_ACTION_SUBJECT_RE.test(subject);
  const collabActivity = classification.collabActivity ?? context.collabActivity ?? null;
  const reason: MeetingDemotionReason | null = MEETING_RECAP_SUBJECT_RE.test(subject)
    ? "meeting_recap"
    : MEETING_PREP_SUBJECT_RE.test(subject)
      ? "meeting_prep"
      : collabActivity != null && isPassiveCollabActivity(collabActivity) && !isCalendarAction
        ? "automated_relay"
        : context.contentFlags?.hasInvestorNotice && !isCalendarAction
          ? "investor_notice"
          : context.contentFlags?.hasPublicEventLanguage && !isCalendarAction
            ? "public_event"
            : null;
  if (!reason) return { classification, demoted: false, reason: null };
  const note =
    reason === "meeting_recap"
      ? "recap of a meeting that already happened"
      : reason === "meeting_prep"
        ? "pre-meeting prep/agenda brief, not a calendar action"
        : reason === "automated_relay"
          ? "automated relay merely mentioning a meeting, not the user's calendar event"
          : reason === "investor_notice"
            ? "AGM/shareholder/proxy notice, not the user's meeting (rule 9)"
            : "public event (webinar/conference/launch), not the user's meeting (rule 8)";
  return {
    classification: {
      ...classification,
      category: "fyi",
      todoSuggestion: null,
      todoDecision: { outcome: "no_obligation", note: `meeting_floor: ${note}` },
      rationale: truncateRationale(
        `${classification.rationale} Meeting floor: ${note} — demoted meeting → fyi (demote, never bury).`,
      ),
    },
    demoted: true,
    reason,
  };
}
