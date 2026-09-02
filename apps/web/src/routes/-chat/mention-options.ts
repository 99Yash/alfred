import { INTEGRATION_DISPLAY_NAMES as NAMES } from "@alfred/contracts";
import { Brain, NotebookPen, type LucideIcon } from "lucide-react";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";

export interface MentionOption {
  value: string;
  label: string;
  subtitle: string;
  brand?: IntegrationBrand | undefined;
  icon?: LucideIcon | undefined;
}

export const MENTION_OPTIONS: ReadonlyArray<MentionOption> = [
  { value: "gmail", label: NAMES.gmail, brand: "gmail", subtitle: "Search your inbox" },
  {
    value: "calendar",
    label: NAMES.calendar,
    brand: "google_calendar",
    subtitle: "Today's events",
  },
  { value: "drive", label: NAMES.drive, brand: "google_drive", subtitle: "Docs and files" },
  { value: "slack", label: NAMES.slack, brand: "slack", subtitle: "Recent messages" },
  { value: "github", label: NAMES.github, brand: "github", subtitle: "Repos and PRs" },
  { value: "linear", label: NAMES.linear, brand: "linear", subtitle: "Issues" },
  { value: "web", label: "Web", brand: "web", subtitle: "Search the web" },
  { value: "memory", label: "Memory", icon: Brain, subtitle: "What Alfred remembers" },
  { value: "notes", label: "Notes", icon: NotebookPen, subtitle: "Your private notes" },
];

const BY_VALUE = new Map(MENTION_OPTIONS.map((o) => [o.value, o]));

export function getMentionOption(value: string | null | undefined): MentionOption | undefined {
  if (!value) return undefined;
  return BY_VALUE.get(value);
}

export function filterMentionOptions(query: string): ReadonlyArray<MentionOption> {
  const q = query.trim().toLowerCase();
  if (!q) return MENTION_OPTIONS;
  return MENTION_OPTIONS.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
  );
}
