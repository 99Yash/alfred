import type { UsageRunCategory } from "@alfred/contracts";
import { APP_TINTS } from "~/lib/tints";

/** Coarse category labels; per-run labels come from the server. */
export const CATEGORY_LABELS = {
  chat: "Chat",
  briefing: "Briefings",
  triage: "Email triage",
  reply_drafting: "Reply drafts",
  cold_start: "Cold-start",
  skill: "Skills",
  memory: "Memory",
  sub_agent: "Sub-agents",
  workflow: "Workflows",
  uncategorized: "Other",
} satisfies Record<UsageRunCategory, string>;

/** Tile classes per category; `workflow` and `uncategorized` are grey, since there are six hues. */
export const CATEGORY_TILE = {
  chat: APP_TINTS.purple,
  briefing: APP_TINTS.amber,
  triage: APP_TINTS.green,
  reply_drafting: APP_TINTS.sky,
  cold_start: APP_TINTS.sky,
  skill: APP_TINTS.orange,
  memory: APP_TINTS.pink,
  sub_agent: APP_TINTS.sky,
  workflow: "bg-app-bg-2 text-app-fg-3",
  uncategorized: "bg-app-bg-2 text-app-fg-3",
} satisfies Record<UsageRunCategory, string>;

export const USAGE_RANGE_PRESETS = ["7d", "30d", "month", "all"] as const;

export type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number];

export const USAGE_RANGE_LABELS = {
  "7d": "7 days",
  "30d": "30 days",
  month: "This month",
  all: "All time",
} satisfies Record<UsageRangePreset, string>;

/** A `[start, end)` window ending now. */
export function resolveRangePreset(preset: UsageRangePreset, now: Date) {
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
      // A fixed floor keeps the key finite and cache-stable.
      return { start: new Date("2024-01-01T00:00:00Z"), end };
  }
}
