import { Brain, NotebookPen, type LucideIcon } from "lucide-react";
import type { IntegrationBrand } from "~/lib/integration-icons";

export interface MentionOption {
  value: string;
  label: string;
  subtitle: string;
  brand?: IntegrationBrand;
  icon?: LucideIcon;
}

export const MENTION_OPTIONS: ReadonlyArray<MentionOption> = [
  { value: "gmail", label: "Gmail", brand: "gmail", subtitle: "Search your inbox" },
  { value: "calendar", label: "Calendar", brand: "google_calendar", subtitle: "Today's events" },
  { value: "drive", label: "Drive", brand: "google_drive", subtitle: "Docs and files" },
  { value: "slack", label: "Slack", brand: "slack", subtitle: "Recent messages" },
  { value: "github", label: "GitHub", brand: "github", subtitle: "Repos and PRs" },
  { value: "linear", label: "Linear", brand: "linear", subtitle: "Issues" },
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
    (o) =>
      o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
  );
}
