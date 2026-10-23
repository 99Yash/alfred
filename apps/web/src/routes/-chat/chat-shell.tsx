import * as Tooltip from "@radix-ui/react-tooltip";
import { RefreshCw } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useArtifactStream } from "~/lib/chat/use-artifact-stream";
import { stopChatRun } from "~/lib/chat/turn-controls";
import { useQueueDispatch } from "~/lib/chat/use-queue-dispatch";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { useRunComplete } from "~/lib/chat/use-run-complete";
import { useSendMessage } from "~/lib/chat/use-send-message";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { useThreadActions } from "~/lib/chat/use-thread-actions";
import { DeleteThreadDialog } from "~/lib/chat/delete-thread-dialog";
import { useChatMessages, useChatThread } from "~/lib/replicache/use-chat";
import { useRightRail } from "~/lib/shell/app-shell";
import { toast } from "~/lib/toast";
import { ArtifactSidebar, type ArtifactEditSuggestion } from "./artifact-sidebar";
import { Composer } from "./composer/composer";
import { useModelTier } from "./composer/use-model-tier";
import { Conversation } from "./conversation";
import { buildFollowUpSuggestions, shouldShowStream } from "./conversation-helpers";
import { EmptyHero } from "./empty-hero";
import { RightRail } from "./rail/right-rail";
import { SelectionQuote } from "./selection-quote";
import { useRailData } from "./rail/use-rail-data";
import { useRailMode } from "./rail/use-rail-mode";
import { TopBar } from "./top-bar";
import { ThreadTotal } from "./thread-usage";
import { pendingToolCallId, useArtifactPanel } from "./use-artifact-panel";

/** Chat scaffold for `/chat` and `/chat/$threadId`: top bar, feed or hero, composer, right rail. */
export interface ChatShellProps {
  threadId: string | undefined;
  title: string;
}

export function ChatShell({ threadId, title }: ChatShellProps) {
  const railMode = useRailMode();
  const [railOpen, setRailOpen] = useState(() => railMode === "inline");
  const railData = useRailData();

  // Reset the rail to the mode's default when the viewport crosses the breakpoint.
  const [prevMode, setPrevMode] = useState(railMode);

  if (prevMode !== railMode) {
    setPrevMode(railMode);
    setRailOpen(railMode === "inline");
  }

  useEffect(() => {
    if (railMode !== "overlay" || !railOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };

    window.addEventListener("keydown", handler);

    return () => window.removeEventListener("keydown", handler);
  }, [railMode, railOpen]);

  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    retry: retryMessages,
  } = useChatMessages(threadId);

  const { stream, stopStream } = useChatStream(threadId);
  useRunComplete(stream);
  const showStream = shouldShowStream(messages, stream);
  const isStreaming = showStream && !stream.done;
  const activeRunId = showStream ? stream.runId : undefined;

  // Artifact sidebar (ADR-0075) shares the right slot with the Today rail and auto-opens the live run's newest artifact.
  // The live stream fills a body before the durable row syncs; resolve the open target's live body here.
  const artifactStream = useArtifactStream(threadId);
  const artifact = useArtifactPanel(threadId, activeRunId, artifactStream);

  const liveArtifact = useMemo(() => {
    if (!artifact.selectedId) return null;
    const pendingTcid = pendingToolCallId(artifact.selectedId);

    return pendingTcid
      ? artifactStream.byToolCallId(pendingTcid)
      : artifactStream.byArtifactId(artifact.selectedId);
  }, [artifact.selectedId, artifactStream]);

  // "Suggest an edit" prefills the composer (ADR-0075 Phase 4). The nonce lets a repeat re-apply.
  // Tagged with its thread so it does not leak into another thread's composer.
  const [editPrefill, setEditPrefill] = useState<
    (ArtifactEditSuggestion & { nonce: number; threadId: string | undefined }) | null
  >(null);

  const onSuggestArtifactEdit = useCallback(
    (suggestion: ArtifactEditSuggestion) => {
      setEditPrefill((prev) => ({
        ...suggestion,
        nonce: (prev?.nonce ?? 0) + 1,
        threadId,
      }));
    },
    [threadId],
  );

  // Memoized so each render does not push a new node into AppShell.
  // The rail stays mounted and collapses while an artifact is open. Both run the same curve,
  // so the slot width moves from one to the other with no jump.
  const slotNode = useMemo(
    () => (
      <>
        <RightRail
          open={railOpen && !artifact.isOpen}
          mode={railMode}
          onClose={() => setRailOpen(false)}
          data={railData}
        />
        <AnimatePresence initial={false}>
          {artifact.selectedId ? (
            // One key for every artifact, so a switch swaps the body and does not replay the slide.
            <ArtifactSidebar
              key="artifact-panel"
              artifactId={artifact.selectedId}
              liveStream={liveArtifact}
              mode={railMode}
              width={artifact.width}
              onWidthChange={artifact.setWidth}
              onClose={artifact.close}
              onSuggestEdit={onSuggestArtifactEdit}
            />
          ) : null}
        </AnimatePresence>
      </>
    ),
    [
      railOpen,
      railMode,
      railData,
      artifact.isOpen,
      artifact.selectedId,
      liveArtifact,
      artifact.width,
      artifact.setWidth,
      artifact.close,
      onSuggestArtifactEdit,
    ],
  );

  useRightRail(slotNode);

  const send = useSendMessage();
  // Persisted Auto/Deep tier, sent with every turn.
  const [tier, setTier] = useModelTier();
  // Text quoted from a reply with "Ask Alfred". It rides on the next send as a blockquote.
  const [quote, setQuote] = useState<string | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  // Reset during render, so a quote does not ride into another thread's composer.
  const [prevThreadId, setPrevThreadId] = useState(threadId);

  if (prevThreadId !== threadId) {
    setPrevThreadId(threadId);
    setQuote(null);
  }

  const awaitingApproval = Boolean(showStream && stream.awaitingApproval);
  const { rows: approvalRows } = useActionStagings();

  const runApprovals = useMemo(
    () => (activeRunId ? approvalRows.filter((row) => row.runId === activeRunId) : []),
    [approvalRows, activeRunId],
  );

  const hasPendingApproval = runApprovals.length > 0;
  const approvalTrayActive = awaitingApproval || hasPendingApproval;

  // Freeze the bubble and show Send this frame, then stop on the server.
  // The worker finalizes the partial reply through normal sync, so stop feels instant.
  const onStopGeneration = useCallback(() => {
    if (!activeRunId) return;
    stopStream();
    void stopChatRun(activeRunId).then((ok) => {
      if (!ok) toast.error("Couldn't stop the reply. Please try again.");
    });
  }, [activeRunId, stopStream]);

  // Steer (#490): stop the reply and send this next. A run parked on an approval cannot stop.
  const canSteer = isStreaming && !approvalTrayActive;

  const queue = useQueueDispatch({
    threadId,
    tier,
    send,
    turn: { onScreen: showStream, streaming: isStreaming, stream },
    canSteer,
    stopGeneration: onStopGeneration,
  });

  const hasConversation = messages.length > 0 || showStream;

  // Chat "Auto" sets the global `user_action_policies.defaultMode`.
  // On `autonomy` the server skips staging, so no tray card shows. Settings rules still override.
  const { policy, setDefaultMode, loading: policyLoading } = useActionPolicy();
  const autoApprove = policy?.defaultMode === "autonomy";
  const autoApprovePending = policyLoading;

  const onToggleAutoApprove = useCallback(() => {
    // After the subscription settles, the server mutator creates the row for a legacy user.
    if (policyLoading) return;
    void setDefaultMode(autoApprove ? "gated" : "autonomy");
  }, [autoApprove, policyLoading, setDefaultMode]);

  /* Same hook as the sidebar row menu: one write path, one optimistic patch.
   * Passing `threadId` arms the bounce to `/chat` after deleting the open thread. */
  const threadActions = useThreadActions(threadId);
  const { thread } = useChatThread(threadId);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const onRenameThread = useCallback(
    (next: string) => {
      if (threadId) threadActions?.rename(threadId, next);
    },
    [threadActions, threadId],
  );

  const onTogglePinThread = useCallback(() => {
    if (threadId) threadActions?.setPinned(threadId, !thread?.pinned);
  }, [threadActions, threadId, thread?.pinned]);

  const onDeleteThread = useCallback(() => {
    if (!threadId) return;
    threadActions?.remove(threadId);
    setDeleteOpen(false);
  }, [threadActions, threadId]);

  // One follow-up becomes composer ghost text (Tab accepts); two or more become chips.
  const followUps = useMemo(
    () => (showStream ? [] : buildFollowUpSuggestions(messages)),
    [messages, showStream],
  );

  const chipFollowUps = useMemo(() => (followUps.length >= 2 ? followUps : []), [followUps]);
  const lastMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null;
  // Per reply: hidden until the next assistant message.
  const [ghostDismissedFor, setGhostDismissedFor] = useState<string | null>(null);
  const ghostSuggestion = followUps.length === 1 ? followUps[0] : undefined;

  const ghostText =
    ghostSuggestion && ghostDismissedFor !== lastMessageId ? ghostSuggestion.text : undefined;

  const onGhostDone = useCallback(() => setGhostDismissedFor(lastMessageId), [lastMessageId]);

  // 600ms skip delay so a sweep across the usage strip does not re-arm the 300ms delay per cell.
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={600}>
      <div className="relative flex h-full min-w-0 flex-col">
        <TopBar
          title={title}
          threadId={threadId}
          pinned={thread?.pinned ?? false}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
          artifacts={artifact.artifacts}
          selectedArtifactId={artifact.selectedId}
          onOpenArtifact={artifact.open}
          onCloseArtifact={artifact.close}
          threadMessages={messages}
          onRename={onRenameThread}
          onTogglePin={onTogglePinThread}
          onDelete={() => setDeleteOpen(true)}
          tier={tier}
          onTierChange={setTier}
          autoApprove={autoApprove}
          autoApprovePending={autoApprovePending}
          onToggleAutoApprove={onToggleAutoApprove}
        />
        <DeleteThreadDialog
          target={deleteOpen ? { title } : null}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={onDeleteThread}
        />
        {hasConversation ? (
          <>
            <Conversation
              messages={messages}
              stream={stream}
              onFollowUp={(text) => void queue.submit(text)}
              onRetry={queue.retry}
              followUps={chipFollowUps}
              onOpenArtifact={artifact.open}
              openArtifactId={artifact.selectedId}
              approvals={runApprovals}
            />
            <div className="shrink-0 px-4 pb-4">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                <ThreadTotal messages={messages} />
                <Composer
                  key={threadId ?? "new"}
                  threadId={threadId}
                  isStreaming={isStreaming}
                  disabled={approvalTrayActive}
                  onSend={queue.submit}
                  onSteer={queue.steer}
                  onStopGeneration={queue.stopReply}
                  prefill={editPrefill}
                  ghostText={ghostText}
                  onGhostAccept={onGhostDone}
                  onGhostDismiss={onGhostDone}
                  autoApprove={autoApprove}
                  autoApprovePending={autoApprovePending}
                  onToggleAutoApprove={onToggleAutoApprove}
                  tier={tier}
                  onTierChange={setTier}
                  queued={queue.tray.items}
                  onRemoveQueued={queue.tray.remove}
                  onSendQueuedNow={queue.tray.sendNow}
                  onUpdateQueued={queue.tray.update}
                  editingQueuedId={queue.tray.editingId}
                  onEditingQueuedChange={queue.tray.setEditingId}
                  steeringQueuedId={queue.tray.steeringId}
                  sendingQueuedId={queue.tray.sendingId}
                  queuePaused={queue.tray.paused}
                  onResumeQueue={queue.tray.resume}
                  quote={quote}
                  onClearQuote={clearQuote}
                />
              </div>
            </div>
            <SelectionQuote onQuote={setQuote} />
          </>
        ) : messagesLoading ? (
          <ConversationLoading />
        ) : messagesError ? (
          <ConversationLoadError message={messagesError} onRetry={retryMessages} />
        ) : (
          <EmptyHero
            threadId={threadId}
            isStreaming={isStreaming}
            onSend={queue.submit}
            autoApprove={autoApprove}
            autoApprovePending={autoApprovePending}
            onToggleAutoApprove={onToggleAutoApprove}
            tier={tier}
            onTierChange={setTier}
            queued={queue.tray.items}
            onRemoveQueued={queue.tray.remove}
            sendingQueuedId={queue.tray.sendingId}
          />
        )}
      </div>
    </Tooltip.Provider>
  );
}

function ConversationLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-8 px-4 py-10"
      role="status"
      aria-label="Loading conversation"
    >
      <span className="sr-only">Loading conversation</span>
      <div className="ml-auto h-5 w-2/5 animate-pulse rounded-sm bg-app-bg-3 motion-reduce:animate-none" />
      <div className="space-y-3">
        <div className="h-4 w-4/5 animate-pulse rounded-sm bg-app-bg-3 motion-reduce:animate-none" />
        <div className="h-4 w-3/5 animate-pulse rounded-sm bg-app-bg-3 motion-reduce:animate-none" />
      </div>
      <div className="h-24 w-full animate-pulse rounded-md bg-app-bg-2 motion-reduce:animate-none" />
    </div>
  );
}

function ConversationLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="text-sm text-app-fg-3">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="app-press inline-flex h-9 items-center gap-2 rounded-md bg-app-bg-2 px-3 text-sm font-medium text-app-fg-4 transition-colors hover:bg-app-bg-a2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-purple-2"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
}
