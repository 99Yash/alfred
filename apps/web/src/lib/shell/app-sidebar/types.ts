import type { ThreadEntry, ThreadGroup } from "~/lib/shell/thread-view-model";

/** Actions a real Replicache-backed surface wires into each chat row. */
export interface SidebarThreadActions {
  rename: (id: string, title: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  remove: (id: string) => void;
}

export interface AppSidebarProps {
  /** Open the cmd-K palette. */
  onOpenSearch: () => void;
  /** Active thread id (drives the highlight on chat rows). Empty string means no highlight. */
  activeThread?: string | undefined;
  /** Thread groups (Pinned / Today / Yesterday / Earlier). */
  threads?: Record<ThreadGroup, ThreadEntry[]> | undefined;
  /** Per-thread rename/pin/delete handlers. Omit to render inert rows. */
  threadActions?: SidebarThreadActions | undefined;
  /** Approvals badge text. Only fixture surfaces pass this. */
  approvalsBadge?: string | undefined;
  /** Whether the sidebar is visible. Default true. */
  open?: boolean | undefined;
  /** Viewport mode: inline (wide, resizable + minimizable) or overlay (narrow drawer). */
  mode?: "inline" | "overlay" | undefined;
  /** Hide the overlay drawer (narrow mode only). */
  onCollapse?: (() => void) | undefined;
}
