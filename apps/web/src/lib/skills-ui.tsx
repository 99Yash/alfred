/**
 * Tiny presentational helpers for the skills pages. Lives outside the
 * route files so the list and detail pages don't drift on tone choices.
 */

const SKILL_STATUS_TONES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  draft: "bg-amber-100 text-amber-800",
};

const RUN_STATUS_TONES: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-700",
};

const NEUTRAL_TONE = "bg-gray-100 text-gray-700";
const IN_FLIGHT_TONE = "bg-amber-100 text-amber-800";

function Pill({ status, tone }: { status: string; tone: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
  );
}

export function SkillStatusPill({ status }: { status: string }) {
  return <Pill status={status} tone={SKILL_STATUS_TONES[status] ?? NEUTRAL_TONE} />;
}

export function RunStatusPill({ status }: { status: string }) {
  return <Pill status={status} tone={RUN_STATUS_TONES[status] ?? IN_FLIGHT_TONE} />;
}
