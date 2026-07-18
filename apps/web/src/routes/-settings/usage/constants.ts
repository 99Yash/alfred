import type { UsageRunCategory } from "@alfred/contracts";
import { APP_TINTS } from "~/lib/tints";

/** Human labels for the coarse run categories (finer per-run labels come from the server). */
export const CATEGORY_LABELS: Record<UsageRunCategory, string> = {
  chat: "Chat",
  briefing: "Briefings",
  triage: "Email triage",
  cold_start: "Cold-start",
  skill: "Skills",
  memory: "Memory",
  sub_agent: "Sub-agents",
  workflow: "Workflows",
  uncategorized: "Other",
};

/**
 * Per-category tint tile (`bg-app-{tone}-1 text-app-{tone}-4`). Reuses the six
 * shared app hues; `workflow`/`uncategorized` fall back to a neutral grey since
 * the palette only has six tones. Same class shape as the settings tiles so the
 * usage pills never drift from the rest of the app.
 */
export const CATEGORY_TILE: Record<UsageRunCategory, string> = {
  chat: APP_TINTS.purple,
  briefing: APP_TINTS.amber,
  triage: APP_TINTS.green,
  cold_start: APP_TINTS.sky,
  skill: APP_TINTS.orange,
  memory: APP_TINTS.pink,
  sub_agent: APP_TINTS.sky,
  workflow: "bg-app-bg-2 text-app-fg-3",
  uncategorized: "bg-app-bg-2 text-app-fg-3",
};

/** Date-range presets for the overview control. `all` reaches before Alfred existed. */
export const USAGE_RANGE_PRESETS = ["7d", "30d", "month", "all"] as const;
export type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number];

export const USAGE_RANGE_LABELS: Record<UsageRangePreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  month: "This month",
  all: "All time",
};

/** Resolve a preset to a concrete [start, end) window (end = now). */
export function resolveRangePreset(preset: UsageRangePreset, now: Date): { start: Date; end: Date } {
  const end = now;
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case "7d":
      return { start: new Date(end.getTime() - 7 * day), end };
    case "30d":
      return { start: new Date(end.getTime() - 30 * day), end };
    case "month":
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
    case "all":
      // Alfred has no data before this; a fixed floor keeps the window a
      // finite, cache-stable key rather than epoch-0.
      return { start: new Date("2024-01-01T00:00:00Z"), end };
  }
}
