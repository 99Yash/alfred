import { Link, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  ChevronsLeft,
  NotebookPen,
  Pin,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  SquarePen,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import { VsThemeToggle } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";

/**
 * Shared in-app sidebar for the visitors-now preview shell.
 *
 * Mounted by `routes/preview.tsx` so chat, integrations, workflows,
 * and settings all share the same workspace nav. The previous design
 * had each preview page own its own sidebar (chat) or no sidebar at
 * all (integrations / workflows / settings) — that meant losing
 * navigation when jumping between surfaces.
 *
 * Nav rows are router-aware: the matching pathname for the current
 * route lights up. Chat thread rows + the new-chat row are visible on
 * every page so the user can always switch threads or start fresh
 * without going back to /preview/chat first.
 *
 * Search row dispatches `onOpenSearch()` instead of navigating — the
 * search palette is a modal overlay, not a route.
 */
export interface PreviewSidebarProps {
  /** Open the cmd-K palette. */
  onOpenSearch: () => void;
  /** Active thread id on the chat page (optional — no chat → no highlight). */
  activeThread?: string;
  /** Callback when a thread row is clicked on the chat page. */
  onSelectThread?: (id: string) => void;
}

type ThreadGroup = "today" | "yesterday" | "earlier";

interface ThreadEntry {
  id: string;
  title: string;
  pinned?: boolean;
  unread?: boolean;
}

const THREADS: Record<ThreadGroup, ThreadEntry[]> = {
  today: [
    { id: "morning-brief", title: "Morning briefing — Friday", pinned: true },
    { id: "sycamore-recap", title: "Sycamore investor update" },
    { id: "calendar-block", title: "Block focus time tomorrow", unread: true },
  ],
  yesterday: [
    { id: "triage-rules", title: "Tune triage label rules" },
    { id: "vesting-q", title: "Vesting cliff question" },
  ],
  earlier: [
    { id: "weekly-recap", title: "Weekly recap — week 21" },
    { id: "cold-start", title: "Cold-start research notes" },
    { id: "memory-cleanup", title: "Memory cleanup pass" },
  ],
};

export function PreviewSidebar({
  onOpenSearch,
  activeThread,
  onSelectThread,
}: PreviewSidebarProps) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChat = path === "/preview/chat";

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "relative shrink-0 w-[264px] h-full",
        "border-r border-vs-bg-3/60",
        "bg-vs-bg-1/40",
        "flex flex-col",
      )}
    >
      {/* Slim chrome row — collapse arrow tucked into the corner. */}
      <div className="px-2 pt-2.5 pb-1 flex items-center justify-end">
        <button
          type="button"
          aria-label="Collapse sidebar"
          className={cn(
            "size-8 inline-flex items-center justify-center rounded-lg",
            "text-vs-fg-2 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
            "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
          )}
        >
          <ChevronsLeft size={15} />
        </button>
      </div>

      <div className="px-2 pt-1 pb-2 space-y-0.5">
        <NavLink icon={SquarePen} label="New chat" to="/preview/chat" kbd="⌘N" active={isChat} />
        <NavButton icon={Search} label="Search" kbd="⌘K" onClick={onOpenSearch} />
        <NavLink
          icon={Plug}
          label="Integrations"
          to="/preview/integrations"
          active={path.startsWith("/preview/integrations")}
        />
        <NavLink
          icon={Workflow}
          label="Workflows"
          to="/preview/workflows"
          active={path.startsWith("/preview/workflows")}
        />
        <NavRow icon={Wrench} label="Skills" />
        <NavRow icon={BookOpen} label="Library" />
        <NavRow icon={ShieldCheck} label="Approvals" badge="2" />
      </div>

      <SidebarHeading>Personal</SidebarHeading>
      <div className="px-2 pb-2 space-y-0.5">
        <NavRow icon={Brain} label="Memory" />
        <NavRow icon={NotebookPen} label="Notes" />
      </div>

      <nav
        aria-label="Chats"
        className={cn(
          "flex-1 min-h-0 overflow-y-auto px-2 pt-1 pb-4 vs-scrollbar",
          "[scrollbar-width:thin]",
        )}
      >
        <ThreadGroupBlock
          label="Today"
          entries={THREADS.today}
          activeId={activeThread}
          onSelect={onSelectThread}
          chatActive={isChat}
        />
        <ThreadGroupBlock
          label="Yesterday"
          entries={THREADS.yesterday}
          activeId={activeThread}
          onSelect={onSelectThread}
          chatActive={isChat}
        />
        <ThreadGroupBlock
          label="Earlier"
          entries={THREADS.earlier}
          activeId={activeThread}
          onSelect={onSelectThread}
          chatActive={isChat}
        />
      </nav>

      <UserRow />
    </aside>
  );
}

function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 pt-3 pb-1 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
      {children}
    </div>
  );
}

interface BaseNavProps {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  badge?: string;
  active?: boolean;
}

const navRowClass = (active = false) =>
  cn(
    "group w-full text-left rounded-xl h-9 px-3 inline-flex items-center gap-2.5",
    "transition-[background-color,color] duration-150 vs-press",
    "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
    active ? "bg-vs-bg-2 text-vs-fg-4" : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
  );

function NavInner({ icon: Icon, label, kbd, badge, active }: BaseNavProps) {
  return (
    <>
      <Icon
        size={14}
        aria-hidden
        className={cn(
          "shrink-0 transition-colors",
          active ? "text-vs-fg-4" : "text-vs-fg-2 group-hover:text-vs-fg-4",
        )}
      />
      <span className="flex-1 min-w-0 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full",
            "text-[10.5px] font-medium tabular-nums",
            "bg-vs-purple-1 text-vs-purple-4",
          )}
        >
          {badge}
        </span>
      ) : null}
      {kbd ? <KbdHint>{kbd}</KbdHint> : null}
    </>
  );
}

function NavRow(props: BaseNavProps) {
  return (
    <button type="button" aria-current={props.active ? "page" : undefined} className={navRowClass(props.active)}>
      <NavInner {...props} />
    </button>
  );
}

function NavButton({ onClick, ...props }: BaseNavProps & { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={props.active ? "page" : undefined}
      className={navRowClass(props.active)}
    >
      <NavInner {...props} />
    </button>
  );
}

function NavLink({ to, ...props }: BaseNavProps & { to: string }) {
  return (
    <Link
      to={to}
      aria-current={props.active ? "page" : undefined}
      className={navRowClass(props.active)}
    >
      <NavInner {...props} />
    </Link>
  );
}

function KbdHint({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-md",
        "text-[10.5px] leading-none font-medium tabular-nums",
        "bg-vs-bg-a2 text-vs-fg-2 font-sans",
      )}
    >
      {children}
    </kbd>
  );
}

function ThreadGroupBlock({
  label,
  entries,
  activeId,
  onSelect,
  chatActive,
}: {
  label: string;
  entries: ReadonlyArray<ThreadEntry>;
  activeId?: string;
  onSelect?: (id: string) => void;
  chatActive: boolean;
}) {
  return (
    <div className="mb-3">
      <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-tight font-medium text-vs-fg-2">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <ThreadRow
            key={entry.id}
            entry={entry}
            active={chatActive && entry.id === activeId}
            chatActive={chatActive}
            onSelect={() => {
              if (chatActive && onSelect) onSelect(entry.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadRow({
  entry,
  active,
  chatActive,
  onSelect,
}: {
  entry: ThreadEntry;
  active: boolean;
  chatActive: boolean;
  onSelect: () => void;
}) {
  // On non-chat pages, clicking a thread row should jump back to chat with
  // that thread loaded. The shared sidebar can't toggle parent state across
  // routes, so we render a real Link that navigates to /preview/chat.
  // (The threadId selection on chat is local state, so we don't actually
  // pass it through the URL yet — clicking from a non-chat page lands on
  // the default thread.)
  const baseClass = cn(
    "group w-full text-left rounded-xl h-9 px-3 inline-flex items-center gap-2",
    "transition-[background-color,color] duration-150 vs-press",
    "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
    active
      ? "bg-vs-bg-2 text-vs-fg-4"
      : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
  );

  const content = (
    <>
      {entry.pinned ? (
        <Pin size={12} aria-hidden className="shrink-0 text-vs-fg-2 group-hover:text-vs-fg-3" />
      ) : entry.unread ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-vs-purple-4" />
      ) : (
        <span aria-hidden className="size-1.5 shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate text-sm font-medium">{entry.title}</span>
    </>
  );

  if (chatActive) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={baseClass}
      >
        {content}
      </button>
    );
  }

  return (
    <Link to="/preview/chat" className={baseClass}>
      {content}
    </Link>
  );
}

function UserRow() {
  return (
    <div className="px-3 py-2 border-t border-vs-bg-3/60 flex items-center gap-1.5">
      <button
        type="button"
        className={cn(
          "flex-1 min-w-0 inline-flex items-center gap-2.5 rounded-xl h-11 px-1.5 pr-2",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-full bg-vs-pink-4 text-white inline-flex items-center justify-center text-sm font-semibold"
        >
          Y
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-medium text-vs-fg-4 truncate">Yash</span>
          <span className="block text-[11px] text-vs-fg-2 truncate">dev.6@oliv.ai</span>
        </span>
        <Settings2 size={14} aria-hidden className="text-vs-fg-2" />
      </button>
      <VsThemeToggle />
    </div>
  );
}
