import type { ThreadGroup } from "~/lib/shell/thread-view-model";

export const RAIL_WIDTH = 64;
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 420;
export const DEFAULT_WIDTH = 264;

export const GROUP_ORDER: ReadonlyArray<{ key: ThreadGroup; label: string }> = [
  { key: "pinned", label: "Pinned" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "earlier", label: "Earlier" },
];
