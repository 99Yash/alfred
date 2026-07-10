import { Link } from "@tanstack/react-router";
import {
  Brain,
  Library,
  Newspaper,
  NotebookPen,
  PanelLeft,
  Plug,
  Search,
  ShieldCheck,
  SquarePen,
  Workflow,
  Wrench,
} from "lucide-react";
import type { ThreadEntry, ThreadGroup } from "~/lib/shell/thread-view-model";
import { cn } from "~/lib/utils";
import { GROUP_ORDER } from "./constants";
import { FooterRow } from "./footer-user-row";
import { NavButton, NavLink, SidebarHeading } from "./navigation-primitives";
import { ThreadGroupBlock } from "./thread-content";
import type { SidebarThreadActions } from "./types";

interface FullContentProps {
  path: string;
  isChat: boolean;
  chevronMode: "inline" | "overlay";
  onChevron: () => void;
  onOpenSearch: () => void;
  approvalsBadge?: string;
  threads?: Record<ThreadGroup, ThreadEntry[]>;
  threadActions?: SidebarThreadActions;
  activeThread?: string;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: ThreadEntry) => void;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (label: string) => void;
}

export function FullContent({
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
      <div className="flex items-center justify-between px-2 pt-2.5 pb-1">
        <Link
          to="/chat"
          aria-label="Alfred — home"
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-lg",
            "app-press transition-colors hover:bg-app-bg-a2",
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
            "inline-flex size-8 items-center justify-center rounded-lg",
            "app-press text-app-fg-2 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      </div>

      <div className="animate-sidebar-reveal space-y-0.5 px-2 pt-1 pb-2">
        <NavLink icon={SquarePen} label="New chat" to="/chat" kbd="⌘J" active={isChat} />
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
          icon={Library}
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

      <div className="animate-sidebar-reveal [animation-delay:55ms]">
        <SidebarHeading>Personal</SidebarHeading>
        <div className="space-y-0.5 px-2 pb-2">
          <NavLink icon={Brain} label="Memory" to="/memory" active={path.startsWith("/memory")} />
          <NavLink
            icon={NotebookPen}
            label="Notes"
            to="/notes"
            active={path.startsWith("/notes")}
          />
        </div>
      </div>

      {threads ? (
        <nav
          aria-label="Chats"
          className="scroll-stable sidebar-scroll-fade animate-sidebar-reveal min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1 pb-4 [animation-delay:110ms]"
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
        <div className="min-h-0 flex-1" />
      )}

      <div className="mt-2.5">
        <FooterRow path={path} />
      </div>
    </>
  );
}
