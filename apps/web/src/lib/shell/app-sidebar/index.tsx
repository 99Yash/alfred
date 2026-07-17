import * as Tooltip from "@radix-ui/react-tooltip";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ThreadEntry } from "~/lib/shell/thread-view-model";
import { cn } from "~/lib/utils";
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, RAIL_WIDTH } from "./constants";
import { FullContent } from "./full-content";
import {
  useCollapsedGroups,
  usePersistentSidebarMinimized,
  usePersistentSidebarWidth,
} from "./persistence";
import { RailContent } from "./rail-content";
import { DeleteThreadDialog } from "./thread-content";
import type { AppSidebarProps } from "./types";

export type { AppSidebarProps, SidebarThreadActions } from "./types";

/**
 * Shared in-app sidebar mounted by `AppShell` on every authenticated route.
 *
 * Visibility and minimized-rail state remain independent so overlay mode can
 * slide the full drawer while inline mode can persist its width and rail state.
 */
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
  const path = useRouterState({ select: (state) => state.location.pathname });
  const isChat = path === "/chat" || path.startsWith("/chat/");

  const [width, setWidth] = usePersistentSidebarWidth(DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const [minimizedPreference, setMinimized] = usePersistentSidebarMinimized(false);
  const [collapsedGroups, toggleGroup] = useCollapsedGroups();
  const [dragging, setDragging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ThreadEntry | null>(null);

  const minimized = mode === "inline" && minimizedPreference;
  const expandedWidth = minimized ? RAIL_WIDTH : width;
  const asideWidth = open ? expandedWidth : 0;

  const handleChevron = () => {
    if (mode === "overlay") onCollapse?.();
    else setMinimized((current) => !current);
  };

  const startResize = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      setDragging(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMove = (pointerEvent: PointerEvent) => {
        const next = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth + (pointerEvent.clientX - startX)),
        );
        setWidth(next);
      };
      const cleanup = () => {
        setDragging(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [width, setWidth],
  );

  const sidebarBody = (
    <div style={{ width: expandedWidth }} className="flex h-full flex-col">
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
  );

  return (
    <Tooltip.Provider delayDuration={250}>
      {mode === "overlay" ? (
        <>
          <button
            type="button"
            aria-label="Close sidebar"
            tabIndex={open ? 0 : -1}
            onClick={onCollapse}
            className={cn(
              "fixed inset-0 z-40 bg-app-background/40 backdrop-blur-[2px]",
              "transition-opacity duration-200",
              open ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
          <aside
            aria-label="Workspace navigation"
            aria-hidden={!open}
            className={cn(
              "fixed top-0 bottom-0 left-0 z-50 max-w-[88vw]",
              "border-r border-app-bg-3/60 bg-app-bg-1",
              "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
              "overflow-hidden transition-transform duration-200 ease-out",
              open ? "translate-x-0" : "-translate-x-full",
            )}
          >
            {sidebarBody}
          </aside>
        </>
      ) : (
        <aside
          aria-label="Workspace navigation"
          aria-hidden={!open}
          style={{ width: asideWidth }}
          className={cn(
            "relative h-full shrink-0 overflow-hidden",
            "rounded-2xl bg-app-bg-1",
            "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
            "flex flex-col",
            !dragging && "transition-[width,opacity,margin] duration-200 ease-out",
            open ? "opacity-100" : "pointer-events-none -mr-1.5 opacity-0",
          )}
        >
          {sidebarBody}
          {!minimized && open ? (
            <hr
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={startResize}
              className={cn(
                "absolute top-0 right-0 z-10 m-0 h-full w-1.5 cursor-col-resize border-0",
                "after:absolute after:top-0 after:right-0 after:h-full after:w-px",
                "after:bg-transparent after:transition-colors hover:after:bg-app-purple-2",
                dragging && "after:bg-app-purple-3",
              )}
            />
          ) : null}
        </aside>
      )}

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
