import { Link } from "@tanstack/react-router";
import {
  Brain,
  Library,
  Newspaper,
  NotebookPen,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Workflow,
  Wrench,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { RailUserButton } from "./footer-user-row";
import { RailButton, RailLink, RailTip } from "./navigation-primitives";
import { railIconClass } from "./navigation-primitives.styles";

interface RailContentProps {
  path: string;
  isChat: boolean;
  onOpenSearch: () => void;
  approvalsBadge?: string;
  onExpand: () => void;
}

export function RailContent({
  path,
  isChat,
  onOpenSearch,
  approvalsBadge,
  onExpand,
}: RailContentProps) {
  return (
    <>
      <div className="flex justify-center px-2 pt-2.5 pb-2">
        <div className="group/logo relative size-9">
          <Link
            to="/chat"
            aria-label="Alfred — home"
            className={cn(
              "absolute inset-0 inline-flex items-center justify-center rounded-xl",
              "transition-opacity duration-150 group-hover/logo:opacity-0",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            )}
          >
            <img src="/images/logo/alfred-logo.svg" alt="" className="size-6 rounded-[7px]" />
          </Link>
          <RailTip label="Expand sidebar">
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={onExpand}
              className={cn(
                railIconClass(false),
                "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150",
                "group-hover/logo:pointer-events-auto group-hover/logo:opacity-100",
                "focus-visible:pointer-events-auto focus-visible:opacity-100",
              )}
            >
              <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </RailTip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto px-2 py-1">
        <RailLink icon={SquarePen} label="New chat" to="/chat" active={isChat} kbd="⌘J" />
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
          icon={Library}
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

      <div className="flex flex-col items-center gap-1 border-t border-app-bg-3/60 p-2">
        <RailLink
          icon={Settings}
          label="Settings"
          to="/settings"
          active={path.startsWith("/settings")}
        />
        <RailUserButton />
      </div>
    </>
  );
}
