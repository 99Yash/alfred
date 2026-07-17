import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Ellipsis, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton, AppInput, useAppTheme } from "~/components/ui/v2";
import type { ThreadEntry } from "~/lib/shell/thread-view-model";
import { cn } from "~/lib/utils";
import type { SidebarThreadActions } from "./types";

interface ThreadGroupBlockProps {
  label: string;
  entries: ReadonlyArray<ThreadEntry>;
  activeId?: string;
  chatActive: boolean;
  threadActions?: SidebarThreadActions;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: ThreadEntry) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function ThreadGroupBlock({
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
  if (entries.length === 0) return null;
  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          "group/heading inline-flex w-full items-center gap-1.5 rounded-lg px-3 pt-2 pb-1",
          "text-[11px] font-medium tracking-tight text-app-fg-2 uppercase",
          "transition-colors hover:text-app-fg-3",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
        )}
      >
        <ChevronDown
          size={12}
          aria-hidden
          className={cn("shrink-0 transition-transform duration-150", collapsed && "-rotate-90")}
        />
        <span>{label}</span>
        <span className="ml-auto text-app-fg-2/70 tabular-nums">{entries.length}</span>
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
  entry: ThreadEntry;
  active: boolean;
  threadActions?: SidebarThreadActions;
  renaming: boolean;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (entry: ThreadEntry) => void;
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
          "inline-flex h-9 w-full items-center gap-2 rounded-xl pr-2 pl-3 text-left",
          "app-press transition-[background-color,color] duration-150",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          active
            ? "sidebar-tile text-app-fg-4"
            : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-[inset_0_1px_0_var(--app-sidebar-tile-highlight)]",
        )}
      >
        {indicator}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.title}</span>
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
  entry: ThreadEntry;
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
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-8 text-sm"
        aria-label="Rename chat"
      />
    </div>
  );
}

function ThreadRowMenu({
  entry,
  active,
  onRename,
  onTogglePin,
  onDelete,
}: {
  entry: ThreadEntry;
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
            "absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-lg",
            "text-app-fg-2 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            active && "text-app-fg-3",
          )}
          onClick={(event) => event.preventDefault()}
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
  "border border-app-bg-3/70 bg-app-bg-1",
  "shadow-[0_8px_28px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.04)]",
  "data-[state=open]:animate-[app-fade-in_120ms_ease-out]",
);

const menuItemClass = cn(
  "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2 text-sm font-medium select-none",
  "text-app-fg-3 outline-none",
  "data-[highlighted]:bg-app-bg-a2 data-[highlighted]:text-app-fg-4",
);

function ThreadMenuContent({
  as,
  entry,
  onRename,
  onTogglePin,
  onDelete,
}: {
  as: "dropdown" | "context";
  entry: ThreadEntry;
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
            "text-app-red-4 data-highlighted:bg-app-red-1 data-highlighted:text-app-red-4",
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

export function DeleteThreadDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: ThreadEntry | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { resolved } = useAppTheme();
  return (
    <Dialog open={!!target} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {target ? (
        <DialogContent
          title="Delete chat?"
          description={`“${target.title}” and its messages will be permanently removed. This can’t be undone.`}
          className="app max-w-sm"
          data-app-theme={resolved}
        >
          <div className="flex justify-end gap-2 px-6 pt-2 pb-5">
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
