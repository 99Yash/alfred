import {
  isPassiveCollabActivity,
  type CollabActivityKind,
  type SenderContext,
} from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import type { FloorResult } from "./floor";

/**
 * Demotes a false `meeting` to `fyi`. The sender-kind floor never covers this lane.
 * Recap/prep key on the subject: meeting-assistant senders parse as `person`.
 * Relay keys on a passive `collabActivity`, not sender shape: real Calendar mail
 * also comes from no-reply addresses. Relay, investor and public-event spare a
 * calendar-action subject ("Invitation:").
 */
export type MeetingDemotionReason =
  | "meeting_recap"
  | "meeting_prep"
  | "automated_relay"
  | "investor_notice"
  | "public_event";

// Anchored at the start, so only a subject that IS a recap/prep matches.
const MEETING_RECAP_SUBJECT_RE =
  /^\s*(?:re:\s*|fwd:\s*)*(?:meeting\s+(?:notes|minutes|recap|summary)|notes\s+from\b|minutes\s+(?:from|of)\b|recap\s+of\b|recap:|post[- ]?meet(?:ing)?\s+summary)/i;

const MEETING_PREP_SUBJECT_RE =
  /^\s*(?:\[[^\]]*\]\s*)*(?:meeting\s+prep\b|prep\s+for\b|agenda\s+for\b|pre[- ]?read\s+for\b)/i;

// Google Calendar action subjects, which stay `meeting`.
const CALENDAR_ACTION_SUBJECT_RE =
  /^\s*(?:re:\s*)?(?:(?:updated\s+)?invitation(?:\s+with\s+note)?|proposed\s+new\s+time|new\s+time\s+proposed|(?:cancelled|canceled)(?:\s+event)?|accepted|declined|tentatively\s+accepted|this\s+event\s+has\s+been\s+(?:updated|cancelled|canceled)|reminder:?\s+.*\bstarts\s+in\b)\b|\binvitation:/i;

export function applyMeetingDemotionFloor(
  classification: TriageClassification,
  context: {
    effectiveAuthor?: SenderContext["effectiveAuthor"] | null;
    senderKind?: Observations["senderKind"];
    subject?: string | null;
    collabActivity?: CollabActivityKind | null;
    contentFlags?: Pick<Observations["content"], "hasInvestorNotice" | "hasPublicEventLanguage">;
  },
): FloorResult & { reason: MeetingDemotionReason | null } {
  if (classification.category !== "meeting") {
    return { verdict: { kind: "keep" }, reason: null };
  }

  const subject = context.subject ?? "";
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

  if (!reason) return { verdict: { kind: "keep" }, reason: null };

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
    verdict: { kind: "demote", key: "meeting_floor", note, reason: `Meeting floor: ${note}` },
    reason,
  };
}
