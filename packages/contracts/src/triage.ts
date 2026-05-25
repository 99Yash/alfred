/**
 * Canonical triage category list. Lives in `@alfred/contracts` so the
 * web bundle can import it without pulling in the Node-only
 * `@alfred/integrations` package. `@alfred/integrations/google/labels`
 * re-exports `TRIAGE_CATEGORIES` and `TriageCategory` from here and adds
 * the integration-specific Gmail label-name mapping on top — there is
 * only one source of truth.
 */

export const TRIAGE_CATEGORIES = [
  "urgent",
  "action_needed",
  "follow_up",
  "awaiting_reply",
  "meeting",
  "fyi",
  "done",
  "payment",
  "newsletter",
  "marketing",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** Short display label for the rail chip. */
export const TRIAGE_DISPLAY: Record<TriageCategory, string> = {
  urgent: "Urgent",
  action_needed: "Action",
  follow_up: "Follow-up",
  awaiting_reply: "Awaiting",
  meeting: "Meeting",
  fyi: "FYI",
  done: "Done",
  payment: "Payment",
  newsletter: "Newsletter",
  marketing: "Marketing",
};

export function isTriageCategory(value: unknown): value is TriageCategory {
  return typeof value === "string" && (TRIAGE_CATEGORIES as readonly string[]).includes(value);
}
