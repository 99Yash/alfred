import type { ThreadActions } from "~/lib/chat/use-thread-actions";
import type { ThreadEntry, ThreadGroup } from "~/lib/shell/thread-view-model";

/** An alias, so the sidebar and the header cannot drift apart. */
export type SidebarThreadActions = ThreadActions;

export interface AppSidebarProps {
  /** Open the cmd-K palette. */
  onOpenSearch: () => void;
  /** Highlights a chat row. Empty string: no highlight. */
  activeThread?: string | undefined;
  threads?: Record<ThreadGroup, ThreadEntry[]> | undefined;
  /** Omit to render inert rows. */
  threadActions?: SidebarThreadActions | undefined;
  /** Approvals badge text. Only fixture surfaces pass this. */
  approvalsBadge?: string | undefined;
  /** Default true. */
  open?: boolean | undefined;
  /** Inline: wide, resizable, minimizable. Overlay: narrow drawer. */
  mode?: "inline" | "overlay" | undefined;
  /** Hide the overlay drawer (narrow mode only). */
  onCollapse?: (() => void) | undefined;
}
