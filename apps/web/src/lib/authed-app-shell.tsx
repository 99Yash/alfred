import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { SyncedChatThread } from "@alfred/sync";
import { AppSidebar } from "~/components/app-sidebar";
import {
  PREVIEW_APPROVALS_BADGE,
  PREVIEW_CHAT_THREADS,
  PREVIEW_RECENT_THREADS,
  type PreviewThreadEntry,
  type PreviewThreadGroup,
} from "~/components/preview-fixtures";
import { SearchPalette } from "~/components/search-palette";
import { AppThemed } from "~/components/ui/v2/themed";
import { useEventBridge } from "~/lib/events/use-event-bridge";
import { useChatThreads } from "~/lib/replicache/use-chat";
import { cn } from "~/lib/utils";

interface AuthedAppShellProps {
  pathname: string;
  mainContent: ReactNode;
  rightRailNode: ReactNode | null;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activeThread: string;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export default function AuthedAppShell({
  pathname,
  mainContent,
  rightRailNode,
  paletteOpen,
  setPaletteOpen,
  activeThread,
  sidebarOpen,
  setSidebarOpen,
}: AuthedAppShellProps) {
  // Single per-session SSE connection that drives React Query invalidations
  // (inbox.updated -> ["me","inbox"]). Mounted in the authenticated shell so
  // public routes do not import the event or sync graph.
  useEventBridge();

  // Live chat threads (Replicache-synced), grouped by recency for the sidebar.
  const chatThreads = useChatThreads();
  const realThreads = useMemo(() => groupChatThreads(chatThreads), [chatThreads]);

  /* `/preview/*` is the fixture-rich design surface. Real routes now feed the
   * sidebar live Replicache-synced chat threads (grouped by recency); the
   * approvals badge + palette recent threads still await their own wiring, so
   * they stay empty on real routes. The preview routes pass demo fixtures so
   * the design surface stays loud regardless. */
  const isPreviewRoute = pathname.startsWith("/preview/");
  const sidebarThreads = isPreviewRoute ? PREVIEW_CHAT_THREADS : realThreads;
  const sidebarApprovalsBadge = isPreviewRoute ? PREVIEW_APPROVALS_BADGE : undefined;
  const paletteRecentThreads = isPreviewRoute ? PREVIEW_RECENT_THREADS : undefined;

  return (
    <AppThemed className="min-h-dvh bg-app-background-subtle">
      <div className="relative flex h-dvh w-full gap-1.5 overflow-hidden p-1.5">
        <AppSidebar
          onOpenSearch={() => setPaletteOpen(true)}
          activeThread={activeThread}
          threads={sidebarThreads}
          approvalsBadge={sidebarApprovalsBadge}
          open={sidebarOpen}
          onCollapse={() => setSidebarOpen(false)}
        />
        <main className="flex flex-1 min-w-0 relative gap-1.5">
          <div
            className={cn(
              "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden",
              "rounded-2xl bg-app-bg-1",
              "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
            )}
          >
            {mainContent}
          </div>
          {rightRailNode}
        </main>
      </div>

      {paletteOpen ? (
        <SearchPalette onClose={() => setPaletteOpen(false)} recentThreads={paletteRecentThreads} />
      ) : null}
    </AppThemed>
  );
}

/**
 * Bucket synced chat threads into the sidebar's Today / Yesterday / Earlier
 * groups by last activity (falling back to creation time for a thread that
 * has no messages yet). `useChatThreads` already sorts newest-first, so each
 * bucket preserves that order. Empty buckets render nothing (the group block
 * skips itself), so a user with no threads gets a clean sidebar.
 */
function groupChatThreads(
  threads: ReadonlyArray<SyncedChatThread>,
): Record<PreviewThreadGroup, PreviewThreadEntry[]> {
  const groups: Record<PreviewThreadGroup, PreviewThreadEntry[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  for (const thread of threads) {
    const when = thread.lastMessageAt ?? thread.createdAt;
    const ts = new Date(when).getTime();
    const entry: PreviewThreadEntry = {
      id: thread.id,
      title: thread.title?.trim() || "New chat",
    };
    if (Number.isNaN(ts) || ts >= startOfToday.getTime()) groups.today.push(entry);
    else if (ts >= startOfYesterday.getTime()) groups.yesterday.push(entry);
    else groups.earlier.push(entry);
  }
  return groups;
}
