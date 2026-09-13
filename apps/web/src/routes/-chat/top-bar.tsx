import type { ChatModelTier } from "@alfred/contracts";
import type { SyncedArtifact, SyncedChatMessage } from "@alfred/sync";
import { PanelLeft, PanelRight, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppInput } from "~/components/ui/v2";
import { useSidebarState } from "~/lib/shell/app-shell";
import { cn } from "~/lib/utils";
import { ArtifactMenu } from "./artifact-menu";
import { IconButton } from "./rail/icon-button";
import { ShareThreadDialog } from "./share-thread-dialog";
import { ThreadMenu } from "./thread-menu";
import { ThreadUsage } from "./thread-usage";
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
  /** Absent until the first turn creates the thread; Share and the menu stay hidden until then. */
  threadId: string | undefined;
  pinned: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  artifacts: SyncedArtifact[];
  selectedArtifactId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onCloseArtifact: () => void;
  /** Durable thread messages, for the dev-gated thread usage rollup. */
  threadMessages?: readonly SyncedChatMessage[] | undefined;
  /** Commit a new title. The bar owns the inline editor; the caller owns the mutator. */
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

  /* Both pieces of state above NAME A THREAD, and `ChatShell` carries no key, so
   * a thread switch re-renders this bar rather than remounting it. Left alone,
   * each one re-targets itself at the new thread in silence:
   *
   *   - `renaming` keeps an uncontrolled input holding the PREVIOUS thread's
   *     text. Press Enter and the new thread takes the old title — a data loss
   *     with no error.
   *   - `shareOpen` keeps the dialog on screen, now publishing a thread the user
   *     was not looking at when they opened it.
   *
   * Reset during render, not in an effect: an effect commits one frame late, and
   * that frame is enough for an Enter keypress to land on the wrong thread. This
   * is the same pure render-phase adjustment `chat-shell.tsx` uses to reset its
   * queue gate. */
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
        {import.meta.env.DEV && threadMessages ? <ThreadUsage messages={threadMessages} /> : null}
      </div>
      <div className="flex items-center gap-1.5">
        {threadId ? (
          <Tip label="Share thread">
            <IconButton label="Share thread" active={shareOpen} onClick={() => setShareOpen(true)}>
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

/**
 * Inline title editor, mirroring the sidebar row's rename affordance rather
 * than opening a dialog: the title is already on screen here, so editing it in
 * place is one fewer surface for the same edit. Commits on blur and Enter,
 * abandons on Escape.
 */
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
