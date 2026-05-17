/**
 * Status pills for the skills pages. Kept in their own file so the list and
 * detail pages don't drift on tone choices. Uses the shared Pill primitive so
 * tones work in both light and dark.
 */

import { Pill } from "~/lib/ui";

type Tone = "neutral" | "positive" | "warning" | "negative" | "info";

const SKILL_STATUS_TONE: Record<string, Tone> = {
  active: "positive",
  draft: "warning",
};

const RUN_STATUS_TONE: Record<string, Tone> = {
  completed: "positive",
  failed: "negative",
  cancelled: "neutral",
};

const IN_FLIGHT_TONE: Tone = "warning";

export function SkillStatusPill({ status }: { status: string }) {
  return <Pill tone={SKILL_STATUS_TONE[status] ?? "neutral"}>{status}</Pill>;
}

export function RunStatusPill({ status }: { status: string }) {
  return <Pill tone={RUN_STATUS_TONE[status] ?? IN_FLIGHT_TONE}>{status}</Pill>;
}
