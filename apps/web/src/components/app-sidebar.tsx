import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  ChevronDown,
  Ellipsis,
  LogOut,
  Newspaper,
  NotebookPen,
  PanelLeft,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Trash2,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton, AppInput, AppThemeToggle, useAppTheme } from "~/components/ui/v2";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import type { PreviewThreadEntry, PreviewThreadGroup } from "./preview-fixtures";

/**
 * Actions a real (Replicache-backed) surface wires into each chat row.
 * Omitted on the `/preview/*` fixture surface, where the rows are inert demo
 * data and a rename/pin/delete would mutate against ids that don't exist.
 */
export interface SidebarThreadActions {
  rename: (id: string, title: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  remove: (id: string) => void;
}

/**
 * Shared in-app sidebar mounted by `AppShell` on every authenticated route.
 *
 * Static chrome (nav rows, search trigger, user row) is always rendered. Chat
 * thread groups are *prop-driven*: real routes feed live Replicache-synced
 * threads (grouped Pinned / Today / Yesterday / Earlier), while `/preview/*`
 * passes the fixture set so the design surface stays populated.
 *
 * Two collapse axes:
 *   - `open`        — visibility. Overlay (narrow) mode toggles this to slide
 *                     the drawer in/out; inline (wide) mode keeps it true.
 *   - `minimized`   — inline-only icon rail (persisted). The header chevron
 *                     toggles it on inline, or hides the drawer on overlay.
 *
 * The expanded width is drag-resizable (persisted). Date groups collapse
 * independently (persisted). Each thread row carries a rename/pin/delete menu
 * (hover ⋯ + right-click) when `threadActions` is supplied.
 */
export interface AppSidebarProps {
  /** Open the cmd-K palette. */
  onOpenSearch: () => void;
  /** Active thread id (drives the highlight on chat rows). Empty string → no highlight. */
  activeThread?: string;
  /** Thread groups (Pinned / Today / Yesterday / Earlier). */
  threads?: Record<PreviewThreadGroup, PreviewThreadEntry[]>;
  /** Per-thread rename/pin/delete handlers. Omit to render inert rows. */
  threadActions?: SidebarThreadActions;
  /** Approvals badge text — only fixture surfaces pass this. */
  approvalsBadge?: string;
  /** Whether the sidebar is visible. Default true. */
  open?: boolean;
  /** Viewport mode: inline (wide, resizable + minimizable) or overlay (narrow drawer). */
  mode?: "inline" | "overlay";
  /** Hide the overlay drawer (narrow mode only). */
  onCollapse?: () => void;
}

const RAIL_WIDTH = 64;
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 264;
const WIDTH_KEY = "alfred:sidebar-width";
const MINIMIZED_KEY = "alfred:sidebar-minimized";
const GROUPS_KEY = "alfred:sidebar-collapsed-groups";

const GROUP_ORDER: ReadonlyArray<{ key: PreviewThreadGroup; label: string }> = [
  { key: "pinned", label: "Pinned" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "earlier", label: "Earlier" },
];

export function AppSidebar({
  onOpenSearch,
  activeThread,
  threads,
  threadActions,
  approvalsBadge,
  open = true,
  mode = "inline",
  onCollapse,
}: AppSidebarProps) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChat = path === "/chat" || path.startsWith("/chat/");

  const [width, setWidth] = usePersistentNumber(WIDTH_KEY, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const [minimizedPref, setMinimized] = usePersistentBoolean(MINIMIZED_KEY, false);
  const [collapsedGroups, toggleGroup] = useCollapsedGroups();
  const [dragging, setDragging] = useState(false);

  // Rail only makes sense inline; an overlay drawer is always full-width.
  const minimized = mode === "inline" && minimizedPref;
  const expandedWidth = minimized ? RAIL_WIDTH : width;
  const asideWidth = open ? expandedWidth : 0;

  // Inline → toggle the icon rail; overlay → hide the drawer.
  const handleChevron = () => {
    if (mode === "overlay") onCollapse?.();
    else setMinimized((m) => !m);
  };

  // Rename / delete UI state (lifted so the dialog survives row re-renders).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PreviewThreadEntry | null>(null);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      setDragging(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
        setWidth(next);
      };
      const onUp = () => {
        setDragging(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth],
  );

  return (
    <Tooltip.Provider delayDuration={250}>
      <aside
        aria-label="Workspace navigation"
        aria-hidden={!open}
        style={{ width: asideWidth }}
        className={cn(
          "relative shrink-0 h-full overflow-hidden",
          "rounded-2xl bg-app-bg-1",
          "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
          "flex flex-col",
          !dragging && "transition-[width,opacity,margin] duration-200 ease-out",
          open ? "opacity-100" : "opacity-0 -mr-1.5 pointer-events-none",
        )}
      >
        <div style={{ width: expandedWidth }} className="h-full flex flex-col">
          {minimized ? (
            <RailContent
              path={path}
              isChat={isChat}
              onOpenSearch={onOpenSearch}
              approvalsBadge={approvalsBadge}
              onExpand={handleChevron}
            />
          ) : (
            <FullContent
              path={path}
              isChat={isChat}
              chevronMode={mode}
              onChevron={handleChevron}
              onOpenSearch={onOpenSearch}
              approvalsBadge={approvalsBadge}
              threads={threads}
              threadActions={threadActions}
              activeThread={activeThread}
              renamingId={renamingId}
              onStartRename={setRenamingId}
              onCommitRename={(id, title) => {
                threadActions?.rename(id, title);
                setRenamingId(null);
              }}
              onCancelRename={() => setRenamingId(null)}
              onRequestDelete={setDeleteTarget}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
            />
          )}
        </div>

        {/* Resize handle — inline + expanded only. */}
        {!minimized && open && mode === "inline" ? (
          <hr
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={startResize}
            className={cn(
              "absolute right-0 top-0 h-full w-1.5 z-10 m-0 border-0 cursor-col-resize",
              "after:absolute after:right-0 after:top-0 after:h-full after:w-px",
              "after:bg-transparent hover:after:bg-app-purple-2 after:transition-colors",
              dragging && "after:bg-app-purple-3",
            )}
          />
        ) : null}
      </aside>

      <DeleteThreadDialog
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) threadActions?.remove(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </Tooltip.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Full (expanded) content                                                    */
/* -------------------------------------------------------------------------- */

interface FullContentProps {
  path: string;
  isChat: boolean;
  chevronMode: "inline" | "overlay";
  onChevron: () => void;
  onOpenSearch: () => void;
  approvalsBadge?: string;
  threads?: Record<PreviewThreadGroup, PreviewThreadEntry[]>;
  threadActions?: SidebarThreadActions;
  activeThread?: string;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: PreviewThreadEntry) => void;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (label: string) => void;
}

function FullContent({
  path,
  isChat,
  chevronMode,
  onChevron,
  onOpenSearch,
  approvalsBadge,
  threads,
  threadActions,
  activeThread,
  renamingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  collapsedGroups,
  onToggleGroup,
}: FullContentProps) {
  return (
    <>
      {/* Slim chrome row — logo home link on the left, collapse/minimize arrow
          tucked into the corner. */}
      <div className="px-2 pt-2.5 pb-1 flex items-center justify-between">
        <Link
          to="/chat"
          aria-label="Alfred — home"
          className={cn(
            "size-8 inline-flex items-center justify-center rounded-lg",
            "hover:bg-app-bg-a2 transition-colors app-press",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <img src="/images/logo/alfred-logo.svg" alt="" className="size-6 rounded-[7px]" />
        </Link>
        <button
          type="button"
          aria-label={chevronMode === "overlay" ? "Hide sidebar" : "Minimize sidebar"}
          onClick={onChevron}
          className={cn(
            "size-8 inline-flex items-center justify-center rounded-lg",
            "text-app-fg-2 hover:bg-app-bg-a2 hover:text-app-fg-4 transition-colors app-press",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
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
        <NavLink icon={NotebookPen} label="Notes" to="/notes" active={path.startsWith("/notes")} />
      </div>

      {threads ? (
        <nav
          aria-label="Chats"
          className="flex-1 min-h-0 overflow-y-auto px-2 pt-1 pb-4 scroll-stable"
        >
          {GROUP_ORDER.map(({ key, label }) => (
            <ThreadGroupBlock
              key={key}
              label={label}
              entries={threads[key]}
              activeId={activeThread}
              chatActive={isChat}
              threadActions={threadActions}
              renamingId={renamingId}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onRequestDelete={onRequestDelete}
              collapsed={collapsedGroups.has(label)}
              onToggle={() => onToggleGroup(label)}
            />
          ))}
        </nav>
      ) : (
        <div className="flex-1 min-h-0" />
      )}

      <FooterRow path={path} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Rail (minimized) content                                                   */
/* -------------------------------------------------------------------------- */

interface RailContentProps {
  path: string;
  isChat: boolean;
  onOpenSearch: () => void;
  approvalsBadge?: string;
  onExpand: () => void;
}

function RailContent({ path, isChat, onOpenSearch, approvalsBadge, onExpand }: RailContentProps) {
  return (
    <>
      <div className="px-2 pt-2.5 pb-1 flex flex-col items-center gap-1">
        <Link
          to="/chat"
          aria-label="Alfred — home"
          className={cn(
            "size-9 inline-flex items-center justify-center rounded-lg",
            "hover:bg-app-bg-a2 transition-colors app-press",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
          )}
        >
          <img src="/images/logo/alfred-logo.svg" alt="" className="size-6 rounded-[7px]" />
        </Link>
        <RailButton icon={PanelLeftOpen} label="Expand sidebar" onClick={onExpand} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 flex flex-col items-center gap-0.5">
        <RailLink icon={SquarePen} label="New chat" to="/chat" active={isChat} />
        <RailButton icon={Search} label="Search" onClick={onOpenSearch} />
        <RailLink
          icon={Plug}
          label="Integrations"
          to="/integrations"
          active={path.startsWith("/integrations")}
        />
        <RailLink
          icon={Workflow}
          label="Workflows"
          to="/workflows"
          active={path.startsWith("/workflows")}
        />
        <RailLink
          icon={Newspaper}
          label="Briefings"
          to="/briefings"
          active={path.startsWith("/briefings")}
        />
        <RailLink icon={Wrench} label="Skills" to="/skills" active={path.startsWith("/skills")} />
        <RailLink
          icon={BookOpen}
          label="Library"
          to="/library"
          active={path.startsWith("/library")}
        />
        <RailLink
          icon={ShieldCheck}
          label="Approvals"
          to="/approvals"
          badge={approvalsBadge}
          active={path.startsWith("/approvals")}
        />
        <div className="my-1 h-px w-6 bg-app-bg-3/60" />
        <RailLink icon={Brain} label="Memory" to="/memory" active={path.startsWith("/memory")} />
        <RailLink icon={NotebookPen} label="Notes" to="/notes" active={path.startsWith("/notes")} />
      </div>

      <div className="p-2 border-t border-app-bg-3/60 flex flex-col items-center gap-1">
        <RailLink
          icon={Settings}
          label="Settings"
          to="/settings"
          active={path.startsWith("/settings")}
        />
        <RailUser />
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Nav primitives                                                             */
/* -------------------------------------------------------------------------- */

function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 pt-3 pb-1 text-[10.5px] uppercase tracking-tight font-medium text-app-fg-2">
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
    "transition-[background-color,color] duration-150 app-press",
    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
    active ? "bg-app-bg-2 text-app-fg-4" : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
  );

function NavInner({ icon: Icon, label, kbd, badge, active }: BaseNavProps) {
  return (
    <>
      <Icon
        size={14}
        aria-hidden
        className={cn(
          "shrink-0 transition-colors",
          active ? "text-app-fg-4" : "text-app-fg-2 group-hover:text-app-fg-4",
        )}
      />
      <span className="flex-1 min-w-0 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full",
            "text-[10.5px] font-medium tabular-nums",
            "bg-app-purple-1 text-app-purple-4",
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
        "bg-app-bg-a2 text-app-fg-3 font-sans",
      )}
    >
      {children}
    </kbd>
  );
}

/* -------------------------------------------------------------------------- */
/* Rail primitives (icon + tooltip)                                           */
/* -------------------------------------------------------------------------- */

const railIconClass = (active = false) =>
  cn(
    "relative size-9 inline-flex items-center justify-center rounded-xl shrink-0",
    "transition-[background-color,color] duration-150 app-press",
    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
    active ? "bg-app-bg-2 text-app-fg-4" : "text-app-fg-2 hover:bg-app-bg-a2 hover:text-app-fg-4",
  );

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  const { resolved } = useAppTheme();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          data-app-theme={resolved}
          className={cn(
            "app z-[200] rounded-lg px-2 py-1 text-xs font-medium",
            "bg-app-fg-4 text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
            "select-none data-[state=delayed-open]:animate-[app-fade-in_120ms_ease-out]",
          )}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function RailLink({
  icon: Icon,
  label,
  to,
  active,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  to: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <RailTip label={label}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={railIconClass(active)}
      >
        <Icon size={16} aria-hidden />
        {badge ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-app-purple-4 text-white text-[9px] font-semibold inline-flex items-center justify-center tabular-nums">
            {badge}
          </span>
        ) : null}
      </Link>
    </RailTip>
  );
}

function RailButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <RailTip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className={railIconClass(false)}>
        <Icon size={16} aria-hidden />
      </button>
    </RailTip>
  );
}

/* -------------------------------------------------------------------------- */
/* Thread groups + rows                                                       */
/* -------------------------------------------------------------------------- */

interface ThreadGroupBlockProps {
  label: string;
  entries: ReadonlyArray<PreviewThreadEntry>;
  activeId?: string;
  chatActive: boolean;
  threadActions?: SidebarThreadActions;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: PreviewThreadEntry) => void;
  collapsed: boolean;
  onToggle: () => void;
}

function ThreadGroupBlock({
  label,
  entries,
  activeId,
  chatActive,
  threadActions,
  renamingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  collapsed,
  onToggle,
}: ThreadGroupBlockProps) {
  // Skip the whole block — heading included — when the bucket is empty, so a
  // user with threads in only one bucket (or none) doesn't see naked headings.
  if (entries.length === 0) return null;
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          "group/heading w-full inline-flex items-center gap-1.5 rounded-lg px-3 pt-2 pb-1",
          "text-[11px] uppercase tracking-tight font-medium text-app-fg-2",
          "hover:text-app-fg-3 transition-colors",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
        )}
      >
        <ChevronDown
          size={12}
          aria-hidden
          className={cn("shrink-0 transition-transform duration-150", collapsed && "-rotate-90")}
        />
        <span>{label}</span>
        <span className="ml-auto tabular-nums text-app-fg-2/70 opacity-0 group-hover/heading:opacity-100 transition-opacity">
          {entries.length}
        </span>
      </button>
      {collapsed ? null : (
        <div className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <ThreadRow
              key={entry.id}
              entry={entry}
              active={chatActive && entry.id === activeId}
              threadActions={threadActions}
              renaming={renamingId === entry.id}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ThreadRowProps {
  entry: PreviewThreadEntry;
  active: boolean;
  threadActions?: SidebarThreadActions;
  renaming: boolean;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: PreviewThreadEntry) => void;
}

function ThreadRow({
  entry,
  active,
  threadActions,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
}: ThreadRowProps) {
  if (renaming) {
    return <ThreadRenameRow entry={entry} onCommit={onCommitRename} onCancel={onCancelRename} />;
  }

  const indicator = entry.pinned ? (
    <Pin size={12} aria-hidden className="shrink-0 text-app-fg-2 group-hover:text-app-fg-3" />
  ) : entry.unread ? (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-app-purple-4" />
  ) : (
    <span aria-hidden className="size-1.5 shrink-0" />
  );

  const row = (
    <div className="group relative">
      <Link
        to="/chat/$threadId"
        params={{ threadId: entry.id }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "w-full text-left rounded-xl h-9 pl-3 pr-2 inline-flex items-center gap-2",
          "transition-[background-color,color] duration-150 app-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          active
            ? "bg-app-bg-2 text-app-fg-4"
            : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
        )}
      >
        {indicator}
        <span className="flex-1 min-w-0 truncate text-sm font-medium">{entry.title}</span>
        {threadActions ? <span aria-hidden className="w-5 shrink-0" /> : null}
      </Link>
      {threadActions ? (
        <ThreadRowMenu
          entry={entry}
          active={active}
          onRename={() => onStartRename(entry.id)}
          onTogglePin={() => threadActions.setPinned(entry.id, !entry.pinned)}
          onDelete={() => onRequestDelete(entry)}
        />
      ) : null}
    </div>
  );

  if (!threadActions) return row;

  // Right-click anywhere on the row opens the same action set.
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ThreadMenuContent
        as="context"
        entry={entry}
        onRename={() => onStartRename(entry.id)}
        onTogglePin={() => threadActions.setPinned(entry.id, !entry.pinned)}
        onDelete={() => onRequestDelete(entry)}
      />
    </ContextMenu.Root>
  );
}

function ThreadRenameRow({
  entry,
  onCommit,
  onCancel,
}: {
  entry: PreviewThreadEntry;
  onCommit: (id: string, title: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const next = ref.current?.value.trim() ?? "";
    if (next && next !== entry.title) onCommit(entry.id, next);
    else onCancel();
  };
  return (
    <div className="px-1.5 py-0.5">
      <AppInput
        ref={ref}
        defaultValue={entry.title}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-8 text-sm"
        aria-label="Rename chat"
      />
    </div>
  );
}

/** The hover ⋯ button that opens the dropdown variant of the thread menu. */
function ThreadRowMenu({
  entry,
  active,
  onRename,
  onTogglePin,
  onDelete,
}: {
  entry: PreviewThreadEntry;
  active: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Chat actions"
          className={cn(
            "absolute right-1.5 top-1/2 -translate-y-1/2 size-6 rounded-lg inline-flex items-center justify-center",
            "text-app-fg-2 hover:bg-app-bg-3 hover:text-app-fg-4 transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            // Hidden until hover/focus/open, so the title has full width at rest.
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            active && "text-app-fg-3",
          )}
          onClick={(e) => e.preventDefault()}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <ThreadMenuContent
        as="dropdown"
        entry={entry}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </DropdownMenu.Root>
  );
}

const menuSurfaceClass = cn(
  "app z-[200] min-w-[168px] rounded-xl p-1",
  "bg-app-bg-1 border border-app-bg-3/70",
  "shadow-[0_8px_28px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.04)]",
  "data-[state=open]:animate-[app-fade-in_120ms_ease-out]",
);

const menuItemClass = cn(
  "flex items-center gap-2.5 h-8 px-2 rounded-lg text-sm font-medium cursor-default select-none",
  "text-app-fg-3 outline-none",
  "data-[highlighted]:bg-app-bg-a2 data-[highlighted]:text-app-fg-4",
);

/**
 * Shared Rename / Pin / Delete item set, rendered into either a Radix
 * DropdownMenu (hover ⋯) or ContextMenu (right-click) portal. Both portal to
 * `document.body`, so the surface carries `.app` + the resolved theme attr to
 * resolve the app-grammar tokens outside the AppThemed subtree.
 */
function ThreadMenuContent({
  as,
  entry,
  onRename,
  onTogglePin,
  onDelete,
}: {
  as: "dropdown" | "context";
  entry: PreviewThreadEntry;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const { resolved } = useAppTheme();
  const Portal = as === "dropdown" ? DropdownMenu.Portal : ContextMenu.Portal;
  const Content = as === "dropdown" ? DropdownMenu.Content : ContextMenu.Content;
  const Item = as === "dropdown" ? DropdownMenu.Item : ContextMenu.Item;
  const Separator = as === "dropdown" ? DropdownMenu.Separator : ContextMenu.Separator;
  const positionProps =
    as === "dropdown" ? { align: "end" as const, sideOffset: 4 } : { alignOffset: 2 };
  return (
    <Portal>
      <Content data-app-theme={resolved} className={menuSurfaceClass} {...positionProps}>
        <Item className={menuItemClass} onSelect={onRename}>
          <Pencil size={14} aria-hidden className="text-app-fg-2" />
          Rename
        </Item>
        <Item className={menuItemClass} onSelect={onTogglePin}>
          {entry.pinned ? (
            <PinOff size={14} aria-hidden className="text-app-fg-2" />
          ) : (
            <Pin size={14} aria-hidden className="text-app-fg-2" />
          )}
          {entry.pinned ? "Unpin" : "Pin"}
        </Item>
        <Separator className="my-1 h-px bg-app-bg-3/70" />
        <Item
          className={cn(
            menuItemClass,
            "text-app-red-4 data-[highlighted]:text-app-red-4 data-[highlighted]:bg-app-red-1",
          )}
          onSelect={onDelete}
        >
          <Trash2 size={14} aria-hidden />
          Delete
        </Item>
      </Content>
    </Portal>
  );
}

function DeleteThreadDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: PreviewThreadEntry | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { resolved } = useAppTheme();
  return (
    <Dialog open={!!target} onOpenChange={(o) => (o ? undefined : onCancel())}>
      {target ? (
        <DialogContent
          title="Delete chat?"
          description={`“${target.title}” and its messages will be permanently removed. This can’t be undone.`}
          className="app max-w-sm"
          data-app-theme={resolved}
        >
          <div className="flex justify-end gap-2 px-6 pb-5 pt-2">
            <AppButton variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </AppButton>
            <AppButton variant="destructive" size="md" onClick={onConfirm}>
              Delete
            </AppButton>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer / user                                                              */
/* -------------------------------------------------------------------------- */

function FooterRow({ path }: { path: string }) {
  return (
    <div className="px-2 pb-1">
      <NavLink
        icon={Settings}
        label="Settings"
        to="/settings"
        active={path.startsWith("/settings")}
      />
      <div className="mt-1">
        <UserRow />
      </div>
    </div>
  );
}

function UserRow() {
  const { name, email, initial, signingOut, signOut } = useUserRow();
  return (
    <div className="px-1 py-1.5 border-t border-app-bg-3/60 flex items-center gap-1.5">
      <Link
        to="/settings"
        className={cn(
          "flex-1 min-w-0 inline-flex items-center gap-2.5 rounded-xl h-11 px-1.5 pr-2",
          "hover:bg-app-bg-a2 transition-colors app-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        )}
      >
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-full bg-app-pink-4 text-white inline-flex items-center justify-center text-sm font-semibold"
        >
          {initial}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-medium text-app-fg-4 truncate">
            {name || "Alfred"}
          </span>
          <span className="block text-[11px] text-app-fg-2 truncate">{email}</span>
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
          "text-app-fg-2 hover:bg-app-bg-a2 hover:text-app-fg-4 transition-colors app-press",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        )}
      >
        <LogOut size={14} aria-hidden />
      </button>
      <AppThemeToggle />
    </div>
  );
}

function RailUser() {
  const { name, email, initial } = useUserRow();
  return (
    <RailTip label={name || email || "Account"}>
      <Link
        to="/settings"
        aria-label="Account settings"
        className={cn(
          "size-9 inline-flex items-center justify-center rounded-full app-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
        )}
      >
        <span
          aria-hidden
          className="size-8 rounded-full bg-app-pink-4 text-white inline-flex items-center justify-center text-sm font-semibold"
        >
          {initial}
        </span>
      </Link>
    </RailTip>
  );
}

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function useUserRow() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const email = session?.user?.email ?? "";
  const name = displayName(session?.user);
  const initial = (name || email || "·").charAt(0).toUpperCase();

  // Navigate even when signOut() rejects — a stale cookie shouldn't strand the
  // user on a page they no longer trust. The guard prevents a double-click
  // firing two parallel signOut requests.
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

  return { name, email, initial, signingOut, signOut };
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) return user.name.trim().split(/\s+/)[0] ?? "";
  if (user.email) return user.email.split("@")[0] ?? "";
  return "";
}

/* -------------------------------------------------------------------------- */
/* Persistence hooks                                                          */
/* -------------------------------------------------------------------------- */

function usePersistentBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue] as const;
}

function usePersistentNumber(key: string, fallback: number, min: number, max: number) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const [value, setValue] = useState<number>(() => {
    if (typeof window === "undefined") return fallback;
    const raw = Number(window.localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : fallback;
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue] as const;
}

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(GROUPS_KEY);
      return raw ? new Set<string>(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      }
      return next;
    });
  }, []);
  return [collapsed, toggle] as const;
}
