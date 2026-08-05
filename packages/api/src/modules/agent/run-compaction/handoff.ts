export const HANDOFF_SECTIONS = [
  "goal",
  "user_directives",
  "decisions",
  "actions_completed",
  "actions_rejected",
  "actions_failed",
  "sub_agent_findings",
  "pending_followups",
  "key_entities",
] as const;

export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

export function extractHandoffSection(
  runSummaryXml: string,
  section: HandoffSection,
): string | null {
  const openClose = new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)<\\/${section}>`, "i");
  const match = openClose.exec(runSummaryXml);
  if (match) return (match[1] ?? "").trim();

  const empty = new RegExp(`<${section}\\b[^>]*/>`, "i");
  return empty.test(runSummaryXml) ? "" : null;
}

export function assertHandoffSections(runSummaryXml: string): void {
  const missing = HANDOFF_SECTIONS.filter(
    (section) => extractHandoffSection(runSummaryXml, section) === null,
  );
  if (missing.length > 0) {
    throw new Error(`run_summary_missing_sections: ${missing.join(", ")}`);
  }
}
