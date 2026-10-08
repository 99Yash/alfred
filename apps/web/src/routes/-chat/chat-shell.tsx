import { isEmptyChatTurnInput } from "@alfred/contracts";
import * as Tooltip from "@radix-ui/react-tooltip";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactStream } from "~/lib/chat/use-artifact-stream";
import { stopChatRun } from "~/lib/chat/turn-controls";
import { useChatQueue } from "~/lib/chat/use-chat-queue";
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

  // Artifact sidebar (ADR-0075) takes the right slot while open and auto-opens the live run's newest artifact.
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
  const railNode = useMemo(
    () => (
      <RightRail
        open={railOpen}
        mode={railMode}
        onClose={() => setRailOpen(false)}
        data={railData}
      />
    ),
    [railOpen, railMode, railData],
  );

  const artifactNode = useMemo(
    () =>
      artifact.selectedId ? (
        <ArtifactSidebar
          artifactId={artifact.selectedId}
          liveStream={liveArtifact}
          mode={railMode}
          width={artifact.width}
          onWidthChange={artifact.setWidth}
          onClose={artifact.close}
          onSuggestEdit={onSuggestArtifactEdit}
        />
      ) : null,
    [
      artifact.selectedId,
      liveArtifact,
      railMode,
      artifact.width,
      artifact.setWidth,
      artifact.close,
      onSuggestArtifactEdit,
    ],
  );

  // The artifact panel wins the slot while open.
  useRightRail(artifactNode ?? railNode);

  const send = useSendMessage();
  // Persisted Auto/Deep tier, sent with every turn.
  const [tier, setTier] = useModelTier();
  // Per-thread client queue (#489): while a reply streams, submits queue as chips.
  // On completion the oldest sends, one at a time. A `busy` reply keeps it queued.
  const { queue, enqueue, remove, dequeue } = useChatQueue(threadId);
  const [queueSending, setQueueSending] = useState(false);
  const prevShowStreamRef = useRef(showStream);
  const lastErrorStreamIdRef = useRef<string | null>(null);
  // Reset during render so the old thread's `showStream` cannot flush the new thread's queue.
  const [prevThreadId, setPrevThreadId] = useState(threadId);

  if (prevThreadId !== threadId) {
    setPrevThreadId(threadId);
    prevShowStreamRef.current = false;
    lastErrorStreamIdRef.current = null;
    setQueueSending(false);
  }

  const onSend = useCallback(
    async (text: string, files?: File[], artifactTargetId?: string): Promise<boolean> => {
      const trimmed = text.trim();
      const hasFiles = Boolean(files && files.length > 0);

      // So the composer does not clear on an empty submit.
      if (
        isEmptyChatTurnInput({
          content: trimmed,
          hasFiles,
          artifactTargetId,
        })
      )
        return false;

      // Queue while a turn is active, including done-but-not-synced, so no stream mounts over that bubble.
      if (showStream) {
        const ok = enqueue({ text: trimmed, files: files ?? [], tier, artifactTargetId });

        return ok;
      }

      const result = await send(
        threadId,
        text,
        tier,
        files,
        undefined,
        undefined,
        artifactTargetId,
      );

      if (result.ok) return true;

      if (result.reason === "busy") {
        // Another turn is in flight (#488). Queue and retry on the next completion.
        const ok = enqueue({ text: trimmed, files: files ?? [], tier, artifactTargetId });

        return ok;
      }

      if (result.reason === "empty") return false;

      // `useSendMessage` already toasted. Keep the draft.
      return false;
    },
    [showStream, enqueue, send, threadId, tier],
  );

  // On completion (stream done and synced), send the oldest queued message.
  // `queueSending` stops a burst while the new stream mounts.
  const streamDone = stream?.done ?? false;
  const streamError = stream?.error ?? null;
  const streamRunId = stream?.runId ?? null;
  useEffect(() => {
    const prev = prevShowStreamRef.current;
    prevShowStreamRef.current = showStream;
    const completed = prev && !showStream;

    // A done stream with an error and no durable message (SSE drop) counts as complete.
    // Send once per `runId+error` to avoid a retry loop.
    const errorId =
      streamDone && streamError ? `${streamRunId ?? "unknown"}:${String(streamError)}` : null;

    const isNewErrorCompletion =
      Boolean(errorId) &&
      errorId !== lastErrorStreamIdRef.current &&
      queue.length > 0 &&
      !queueSending &&
      !isStreaming;

    if (isNewErrorCompletion && errorId) lastErrorStreamIdRef.current = errorId;

    if (!streamDone || !streamError) lastErrorStreamIdRef.current = null;
    const shouldFlush = completed || isNewErrorCompletion;

    if (!shouldFlush || queue.length === 0 || queueSending || isStreaming) return;
    const next = queue[0];

    if (!next) return;
    setQueueSending(true);
    void (async () => {
      const result = await send(
        threadId,
        next.text,
        next.tier,
        next.files,
        next.retryAttachmentIds,
        next.retryAttachmentMessageId,
        next.artifactTargetId,
      );

      if (result.ok) {
        dequeue();
      } else if (result.reason === "busy") {
        // Keep queued; the next completion retries. The chip shows it, so no toast.
      } else if (result.reason === "empty") {
        // Drop a stale empty entry so it does not block the queue.
        dequeue();
      } else {
        // Hard error, already toasted: keep it queued.
      }

      setQueueSending(false);
    })();
  }, [
    showStream,
    queue,
    queueSending,
    isStreaming,
    send,
    threadId,
    dequeue,
    streamDone,
    streamError,
    streamRunId,
  ]);

  // Retry sends the attachment ids, not files; the server copies the bytes (ADR-0065).
  const onRetry = useCallback(
    (text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => {
      void (async () => {
        const result = await send(
          threadId,
          text,
          tier,
          undefined,
          retryAttachmentIds,
          retryAttachmentMessageId,
        );

        if (!result.ok && result.reason === "busy") {
          // On a collision, queue it with its attachment ids.
          enqueue({
            text,
            files: [],
            tier,
            artifactTargetId: undefined,
            retryAttachmentIds,
            retryAttachmentMessageId,
          });
        }
      })();
    },
    [send, threadId, tier, enqueue],
  );

  const awaitingApproval = Boolean(showStream && stream.awaitingApproval);
  const { rows: approvalRows } = useActionStagings();

  const runApprovals = useMemo(
    () => (activeRunId ? approvalRows.filter((row) => row.runId === activeRunId) : []),
    [approvalRows, activeRunId],
  );

  const hasPendingApproval = runApprovals.length > 0;
  const approvalTrayActive = awaitingApproval || hasPendingApproval;
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

  // Freeze the bubble and show Send this frame, then stop on the server.
  // The worker finalizes the partial reply through normal sync, so stop feels instant.
  const onStopGeneration = useCallback(() => {
    if (!activeRunId) return;
    stopStream();
    void stopChatRun(activeRunId).then((ok) => {
      if (!ok) toast.error("Couldn't stop the reply. Please try again.");
    });
  }, [activeRunId, stopStream]);

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
              onFollowUp={onSend}
              onRetry={onRetry}
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
                  onSend={onSend}
                  onStopGeneration={onStopGeneration}
                  prefill={editPrefill}
                  ghostText={ghostText}
                  onGhostAccept={onGhostDone}
                  onGhostDismiss={onGhostDone}
                  autoApprove={autoApprove}
                  autoApprovePending={autoApprovePending}
                  onToggleAutoApprove={onToggleAutoApprove}
                  tier={tier}
                  onTierChange={setTier}
                  queued={queue}
                  onRemoveQueued={remove}
                />
              </div>
            </div>
          </>
        ) : messagesLoading ? (
          <ConversationLoading />
        ) : messagesError ? (
          <ConversationLoadError message={messagesError} onRetry={retryMessages} />
        ) : (
          <EmptyHero
            threadId={threadId}
            isStreaming={isStreaming}
            onSend={onSend}
            autoApprove={autoApprove}
            autoApprovePending={autoApprovePending}
            onToggleAutoApprove={onToggleAutoApprove}
            tier={tier}
            onTierChange={setTier}
            queued={queue}
            onRemoveQueued={remove}
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
