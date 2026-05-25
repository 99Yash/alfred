/**
 * Browser-safe mirror of the triage category list. The canonical source
 * lives in `@alfred/integrations/google/labels` but that package is
 * Node-only — the web bundle needs the category enum for the rail's
 * category chip and category filter, so we keep a tiny constant here.
 *
 * Keep the order + spelling in sync with `TRIAGE_CATEGORIES` in
 * `packages/integrations/src/google/labels.ts`.
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
