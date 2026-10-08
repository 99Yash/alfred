import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { SyncedChatThread } from "@alfred/sync";
import { EventStreamBanner } from "~/components/event-stream-banner";
import { DeliveryAlertBanner } from "~/components/delivery-alert-banner";
import { GithubReconnectBanner } from "~/components/github-reconnect-banner";
import { ScopeGapBanner } from "~/components/scope-gap-banner";
import { AppThemed } from "~/components/ui/v2/themed";
import { useEventBridge } from "~/lib/events/use-event-bridge";
import { useChatThreads } from "~/lib/replicache/use-chat";
import { useThreadActions } from "~/lib/chat/use-thread-actions";
import { AppSidebar } from "~/lib/shell/app-sidebar";
import { SearchPalette } from "~/lib/shell/search-palette";
import type {
  RecentThread,
  ShellThreadViewModel,
  ThreadEntry,
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
  // Here, not in AppShell, so public routes do not load the event and sync code.
  useEventBridge();

  const chatThreads = useChatThreads();
  const realThreads = useMemo(() => groupChatThreads(chatThreads), [chatThreads]);
  const realRecentThreads = useMemo(() => recentThreadsForPalette(chatThreads), [chatThreads]);

  const sidebarThreads = threadViewModel?.groups ?? realThreads;
  const sidebarApprovalsBadge = threadViewModel?.approvalsBadge;
  const paletteRecentThreads = threadViewModel?.recent ?? realRecentThreads;

  /* Not on preview routes: their rows are demo ids no mutator should touch. */
  const realThreadActions = useThreadActions(activeThread);
  const threadActions = threadViewModel ? undefined : realThreadActions;

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
            {/* Notices sit 8px under the header; only the cards take clicks. */}
            <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex flex-col items-center gap-2 px-3">
              <ScopeGapBanner />
              <GithubReconnectBanner />
              <DeliveryAlertBanner />
              <EventStreamBanner />
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

/** Pinned, Today, Yesterday, Earlier, by last activity, else creation time. */
function groupChatThreads(threads: ReadonlyArray<SyncedChatThread>) {
  const newEntries = (): ThreadEntry[] => [];

  const groups = {
    pinned: newEntries(),
    today: newEntries(),
    yesterday: newEntries(),
    earlier: newEntries(),
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

const PALETTE_THREAD_LIMIT = 12;

/** The newest threads as palette rows. The input is already sorted newest first. */
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
