import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  LogOut,
  Newspaper,
  NotebookPen,
  PanelLeft,
  Pin,
  Plug,
  Search,
  ShieldCheck,
  SquarePen,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { VsThemeToggle } from "~/components/ui/visitors";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import type { PreviewThreadEntry, PreviewThreadGroup } from "./preview-fixtures";

/**
 * Shared in-app sidebar mounted by `AppShell` on every authenticated route.
 *
 * Static chrome (nav rows, search trigger, user row) is always rendered.
 * Chat thread groups + the Approvals badge are *prop-driven*: real `/chat`
 * passes nothing (no fixtures until Replicache lands in m13), while the
 * `/preview/*` demo passes the fixture set from `components/preview-fixtures`
 * to make the design surface look populated.
 *
 * Search row dispatches `onOpenSearch()` instead of navigating — the search
 * palette is a modal overlay, not a route.
 */
export interface AppSidebarProps {
  /** Open the cmd-K palette. */
  onOpenSearch: () => void;
  /** Active thread id (drives the highlight on chat rows). Empty string → no highlight. */
  activeThread?: string;
  /** Fixture thread groups — only the `/preview/*` shell passes this. */
  threads?: Record<PreviewThreadGroup, PreviewThreadEntry[]>;
  /** Approvals badge text — only fixture surfaces pass this. */
  approvalsBadge?: string;
  /** Whether the sidebar is visible. Default true. */
  open?: boolean;
  /** Called when the user clicks the collapse chevron. */
  onCollapse?: () => void;
}

export function AppSidebar({
  onOpenSearch,
  activeThread,
  threads,
  approvalsBadge,
  open = true,
  onCollapse,
}: AppSidebarProps) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChat = path === "/chat" || path.startsWith("/chat/");

  return (
    <aside
      aria-label="Workspace navigation"
      aria-hidden={!open}
      className={cn(
        "relative shrink-0 h-full overflow-hidden",
        "rounded-2xl bg-vs-bg-1",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
        "flex flex-col",
        "transition-[width,opacity,margin] duration-200 ease-out",
        open ? "w-[264px] opacity-100" : "w-0 opacity-0 -mr-1.5 pointer-events-none",
      )}
    >
      <div className="w-[264px] h-full flex flex-col">
        {/* Slim chrome row — collapse arrow tucked into the corner. */}
        <div className="px-2 pt-2.5 pb-1 flex items-center justify-end">
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={onCollapse}
            className={cn(
              "size-8 inline-flex items-center justify-center rounded-lg",
              "text-vs-fg-2 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
            )}
          >
            <PanelLeft size={14} />
          </button>
        </div>

        <div className="px-2 pt-1 pb-2 space-y-0.5">
          <NavLink icon={SquarePen} label="New chat" to="/chat" kbd="⌘N" active={isChat} />
          <NavButton icon={Search} label="Search" kbd="⌘K" onClick={onOpenSearch} />
          <NavLink
            icon={Plug}
            label="Integrations"
            to="/integrations"
            active={path.startsWith("/integrations")}
          />
          <NavLink
            icon={Workflow}
            label="Workflows"
            to="/workflows"
            active={path.startsWith("/workflows")}
          />
          <NavLink
            icon={Newspaper}
            label="Briefings"
            to="/briefings"
            active={path.startsWith("/briefings")}
          />
          <NavLink icon={Wrench} label="Skills" to="/skills" active={path.startsWith("/skills")} />
          <NavLink
            icon={BookOpen}
            label="Library"
            to="/library"
            active={path.startsWith("/library")}
          />
          <NavLink
            icon={ShieldCheck}
            label="Approvals"
            to="/approvals"
            badge={approvalsBadge}
            active={path.startsWith("/approvals")}
          />
        </div>

        <SidebarHeading>Personal</SidebarHeading>
        <div className="px-2 pb-2 space-y-0.5">
          <NavLink icon={Brain} label="Memory" to="/memory" active={path.startsWith("/memory")} />
          <NavLink
            icon={NotebookPen}
            label="Notes"
            to="/notes"
            active={path.startsWith("/notes")}
          />
        </div>

        {threads ? (
          <nav aria-label="Chats" className="flex-1 min-h-0 overflow-y-auto px-2 pt-1 pb-4">
            <ThreadGroupBlock
              label="Today"
              entries={threads.today}
              activeId={activeThread}
              chatActive={isChat}
            />
            <ThreadGroupBlock
              label="Yesterday"
              entries={threads.yesterday}
              activeId={activeThread}
              chatActive={isChat}
            />
            <ThreadGroupBlock
              label="Earlier"
              entries={threads.earlier}
              activeId={activeThread}
              chatActive={isChat}
            />
          </nav>
        ) : (
          <div className="flex-1 min-h-0" />
        )}

        <UserRow />
      </div>
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
  chatActive,
}: {
  label: string;
  entries: ReadonlyArray<PreviewThreadEntry>;
  activeId?: string;
  chatActive: boolean;
}) {
  // Skip the whole block — heading included — when the bucket is empty, so a
  // user with threads in only one bucket (or none) doesn't see naked headings.
  if (entries.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-tight font-medium text-vs-fg-2">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <ThreadRow key={entry.id} entry={entry} active={chatActive && entry.id === activeId} />
        ))}
      </div>
    </div>
  );
}

function ThreadRow({ entry, active }: { entry: PreviewThreadEntry; active: boolean }) {
  return (
    <Link
      to="/chat/$threadId"
      params={{ threadId: entry.id }}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group w-full text-left rounded-xl h-9 px-3 inline-flex items-center gap-2",
        "transition-[background-color,color] duration-150 vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        active ? "bg-vs-bg-2 text-vs-fg-4" : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      {entry.pinned ? (
        <Pin size={12} aria-hidden className="shrink-0 text-vs-fg-2 group-hover:text-vs-fg-3" />
      ) : entry.unread ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-vs-purple-4" />
      ) : (
        <span aria-hidden className="size-1.5 shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate text-sm font-medium">{entry.title}</span>
    </Link>
  );
}

function UserRow() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const email = session?.user?.email ?? "";
  const name = displayName(session?.user);
  const initial = (name || email || "·").charAt(0).toUpperCase();

  // Navigate even when signOut() rejects — a stale cookie shouldn't strand
  // the user on a page they no longer trust. The setSigningOut guard prevents
  // a double-click from firing two parallel signOut requests.
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("Sign out failed", err);
    } finally {
      await navigate({ to: "/login" });
      setSigningOut(false);
    }
  };

  return (
    <div className="px-3 py-2 border-t border-vs-bg-3/60 flex items-center gap-1.5">
      <Link
        to="/settings"
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
          {initial}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-medium text-vs-fg-4 truncate">
            {name || "Alfred"}
          </span>
          <span className="block text-[11px] text-vs-fg-2 truncate">{email}</span>
        </span>
      </Link>
      <button
        type="button"
        onClick={signOut}
        disabled={signingOut}
        aria-label="Sign out"
        title="Sign out"
        className={cn(
          "size-8 inline-flex items-center justify-center rounded-lg",
          "text-vs-fg-2 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <LogOut size={14} aria-hidden />
      </button>
      <VsThemeToggle />
    </div>
  );
}

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) return user.name.trim().split(/\s+/)[0] ?? "";
  if (user.email) return user.email.split("@")[0] ?? "";
  return "";
}
