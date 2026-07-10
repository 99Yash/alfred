import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { SyncedChatThread } from "@alfred/sync";
import { GithubReconnectBanner } from "~/components/github-reconnect-banner";
import { ScopeGapBanner } from "~/components/scope-gap-banner";
import { AppThemed } from "~/components/ui/v2/themed";
import { useEventBridge } from "~/lib/events/use-event-bridge";
import { useReplicache } from "~/lib/replicache/context";
import { useChatThreads } from "~/lib/replicache/use-chat";
import { AppSidebar, type SidebarThreadActions } from "~/lib/shell/app-sidebar";
import { SearchPalette } from "~/lib/shell/search-palette";
import type {
  RecentThread,
  ShellThreadViewModel,
  ThreadEntry,
  ThreadGroup,
} from "~/lib/shell/thread-view-model";
import { cn } from "~/lib/utils";

interface AuthedAppShellProps {
  mainContent: ReactNode;
  rightRailNode: ReactNode | null;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activeThread: string;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarMode: "inline" | "overlay";
  threadViewModel: ShellThreadViewModel | null;
}

export default function AuthedAppShell({
  mainContent,
  rightRailNode,
  paletteOpen,
  setPaletteOpen,
  activeThread,
  sidebarOpen,
  setSidebarOpen,
  sidebarMode,
  threadViewModel,
}: AuthedAppShellProps) {
  // Single per-session SSE connection that drives React Query invalidations
  // (inbox.updated -> ["me","inbox"]). Mounted in the authenticated shell so
  // public routes do not import the event or sync graph.
  useEventBridge();
  const navigate = useNavigate();

  // Live chat threads (Replicache-synced), grouped by recency for the sidebar
  // and flattened into "Recent chats" rows for the ⌘K palette.
  const rep = useReplicache();
  const chatThreads = useChatThreads();
  const realThreads = useMemo(() => groupChatThreads(chatThreads), [chatThreads]);
  const realRecentThreads = useMemo(() => recentThreadsForPalette(chatThreads), [chatThreads]);

  const sidebarThreads = threadViewModel?.groups ?? realThreads;
  const sidebarApprovalsBadge = threadViewModel?.approvalsBadge;
  const paletteRecentThreads = threadViewModel?.recent ?? realRecentThreads;

  /* Rename / pin / delete run as Replicache mutators (optimistic patch, then
   * the next pull confirms). Wired only on real routes — preview rows are
   * inert demo ids that no mutator should touch. Deleting the open thread
   * bounces back to a fresh /chat. */
  const threadActions = useMemo<SidebarThreadActions | undefined>(() => {
    if (threadViewModel || !rep) return undefined;
    return {
      rename: (id, title) => void rep.mutate.chatThreadRename({ id, title }),
      setPinned: (id, pinned) => void rep.mutate.chatThreadSetPinned({ id, pinned }),
      remove: (id) => {
        void rep.mutate.chatThreadDelete({ id });
        if (activeThread === id) void navigate({ to: "/chat" });
      },
    };
  }, [threadViewModel, rep, activeThread, navigate]);

  return (
    <AppThemed className="min-h-dvh bg-app-background-subtle">
      <div className="relative flex h-dvh w-full gap-1.5 overflow-hidden p-1.5">
        <AppSidebar
          onOpenSearch={() => setPaletteOpen(true)}
          activeThread={activeThread}
          threads={sidebarThreads}
          threadActions={threadActions}
          approvalsBadge={sidebarApprovalsBadge}
          open={sidebarOpen}
          mode={sidebarMode}
          onCollapse={() => setSidebarOpen(false)}
        />
        <main className="relative flex min-w-0 flex-1 gap-1.5">
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              "rounded-2xl bg-app-bg-1",
              "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
            )}
          >
            {/* Floating notice layer: tucked just under the header (h-14 = 56px)
             * with an extra 8px gap (top-16 = 64px) so the card shadow does not
             * clip the header border. Pointer-transparent so it overlays the chat
             * surface without shifting its layout; only the cards catch clicks. */}
            <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex flex-col items-center gap-2 px-3">
              <ScopeGapBanner />
              <GithubReconnectBanner />
            </div>
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
 * Bucket synced chat threads into the sidebar's Pinned / Today / Yesterday /
 * Earlier groups. Pinned threads float into their own group regardless of age;
 * the rest fall into date buckets by last activity (falling back to creation
 * time for a thread with no messages yet). `useChatThreads` already sorts
 * newest-first, so each bucket preserves that order. Empty buckets render
 * nothing (the group block skips itself), so a user with no threads gets a
 * clean sidebar.
 */
function groupChatThreads(
  threads: ReadonlyArray<SyncedChatThread>,
): Record<ThreadGroup, ThreadEntry[]> {
  const groups: Record<ThreadGroup, ThreadEntry[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    earlier: [],
  };
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  for (const thread of threads) {
    const entry: ThreadEntry = {
      id: thread.id,
      title: thread.title?.trim() || "New chat",
      pinned: thread.pinned,
    };
    if (thread.pinned) {
      groups.pinned.push(entry);
      continue;
    }
    const when = thread.lastMessageAt ?? thread.createdAt;
    const ts = new Date(when).getTime();
    if (Number.isNaN(ts) || ts >= startOfToday.getTime()) groups.today.push(entry);
    else if (ts >= startOfYesterday.getTime()) groups.yesterday.push(entry);
    else groups.earlier.push(entry);
  }
  return groups;
}

/** How many threads the ⌘K palette surfaces before the user starts typing. */
const PALETTE_THREAD_LIMIT = 12;

/**
 * Flatten the newest threads into the palette's "Recent chats" rows with a
 * relative `when` label (Today / Yesterday / "May 30"). `useChatThreads`
 * already sorts newest-first, so a plain slice keeps the most recent.
 */
function recentThreadsForPalette(threads: ReadonlyArray<SyncedChatThread>): RecentThread[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  return threads.slice(0, PALETTE_THREAD_LIMIT).map((thread) => {
    const ts = new Date(thread.lastMessageAt ?? thread.createdAt);
    const when =
      Number.isNaN(ts.getTime()) || ts >= startOfToday
        ? "Today"
        : ts >= startOfYesterday
          ? "Yesterday"
          : ts.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { id: thread.id, title: thread.title?.trim() || "New chat", when };
  });
}
