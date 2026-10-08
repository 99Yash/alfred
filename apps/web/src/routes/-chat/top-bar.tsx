import type { ChatModelTier } from "@alfred/contracts";
import type { SyncedArtifact, SyncedChatMessage } from "@alfred/sync";
import { PanelLeft, PanelRight, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppInput } from "~/components/ui/v2";
import { useSidebarState } from "~/lib/shell/app-shell";
import { prefetchThreadShares } from "~/lib/sharing/use-thread-sharing";
import { cn } from "~/lib/utils";
import { ArtifactMenu } from "./artifact-menu";
import { IconButton } from "./rail/icon-button";
import { ShareThreadDialog } from "./share-thread-dialog";
import { ThreadMenu } from "./thread-menu";
import { Tip } from "./tip";

export function TopBar({
  title,
  threadId,
  pinned,
  railOpen,
  onToggleRail,
  artifacts,
  selectedArtifactId,
  onOpenArtifact,
  onCloseArtifact,
  threadMessages,
  onRename,
  onTogglePin,
  onDelete,
  tier,
  onTierChange,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
}: {
  title: string;
  /** Absent until the first turn creates the thread; Share and the menu hide until then. */
  threadId: string | undefined;
  pinned: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  artifacts: SyncedArtifact[];
  selectedArtifactId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onCloseArtifact: () => void;
  /** For the thread menu's usage rollup. */
  threadMessages?: readonly SyncedChatMessage[] | undefined;
  /** The bar owns the inline editor; the caller owns the mutator. */
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onDelete: () => void;
  tier: ChatModelTier;
  onTierChange: (tier: ChatModelTier) => void;
  autoApprove: boolean;
  autoApprovePending: boolean;
  onToggleAutoApprove: () => void;
}) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarState();
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const messages = threadMessages ?? [];
  const queryClient = useQueryClient();

  /* `ChatShell` has no key, so a thread switch re-renders this bar with stale state:
   * `renaming` would give the new thread the old title on Enter, and `shareOpen` would publish the wrong thread.
   * Reset during render: an effect is one frame late, enough for an Enter to land. */
  const [prevThreadId, setPrevThreadId] = useState(threadId);

  if (prevThreadId !== threadId) {
    setPrevThreadId(threadId);
    setRenaming(false);
    setShareOpen(false);
  }

  return (
    <header
      className={cn(
        "app-frost-header sticky top-0 z-10",
        "flex h-14 shrink-0 items-center justify-between gap-3 px-5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {!sidebarOpen ? (
          <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={14} />
          </IconButton>
        ) : null}
        {renaming ? (
          <TitleEditor
            title={title}
            onCommit={(next) => {
              if (next && next !== title) onRename(next);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h1 className="truncate text-sm font-medium text-app-fg-4">{title}</h1>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {threadId ? (
          <Tip label="Share thread">
            <IconButton
              label="Share thread"
              active={shareOpen}
              onClick={() => setShareOpen(true)}
              onMouseEnter={() => prefetchThreadShares(queryClient, threadId)}
              onFocus={() => prefetchThreadShares(queryClient, threadId)}
            >
              <Share2 size={14} />
            </IconButton>
          </Tip>
        ) : null}
        <ThreadMenu
          threadId={threadId}
          title={title}
          pinned={pinned}
          messages={messages}
          onRename={() => setRenaming(true)}
          onTogglePin={onTogglePin}
          onDelete={onDelete}
          tier={tier}
          onTierChange={onTierChange}
          autoApprove={autoApprove}
          autoApprovePending={autoApprovePending}
          onToggleAutoApprove={onToggleAutoApprove}
        />
        <span aria-hidden className="mx-1 h-5 w-px bg-app-bg-3" />
        <ArtifactMenu
          artifacts={artifacts}
          selectedId={selectedArtifactId}
          onOpen={onOpenArtifact}
          onClose={onCloseArtifact}
        />
        <Tip label={railOpen ? "Hide today panel" : "Show today panel"}>
          <IconButton
            label={railOpen ? "Hide today panel" : "Show today panel"}
            onClick={onToggleRail}
            active={railOpen}
          >
            <PanelRight size={14} />
          </IconButton>
        </Tip>
      </div>
      <ShareThreadDialog threadId={threadId} open={shareOpen} onOpenChange={setShareOpen} />
    </header>
  );
}

/** Inline title editor. Commits on blur and Enter; Escape cancels. */
function TitleEditor({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onCommit(ref.current?.value.trim() ?? "");

  return (
    <AppInput
      ref={ref}
      defaultValue={title}
      aria-label="Rename thread"
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
      className="h-8 max-w-xs text-sm"
    />
  );
}
