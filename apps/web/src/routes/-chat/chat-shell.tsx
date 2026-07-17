import * as Tooltip from "@radix-ui/react-tooltip";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useArtifactStream } from "~/lib/chat/use-artifact-stream";
import { stopChatRun } from "~/lib/chat/turn-controls";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { useRunComplete } from "~/lib/chat/use-run-complete";
import { useSendMessage } from "~/lib/chat/use-send-message";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { useChatMessages } from "~/lib/replicache/use-chat";
import { useRightRail } from "~/lib/shell/app-shell";
import { toast } from "~/lib/toast";
import { ChatApprovalTray } from "./approval-tray";
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
import { pendingToolCallId, useArtifactPanel } from "./use-artifact-panel";

/**
 * Fixture-free chat scaffold shared by `/chat` and `/chat/$threadId`.
 *
 * Top bar with the thread title + action buttons (share, more, rail toggle).
 * Below: a centered empty-state hero (date · greeting · tagline · composer ·
 * connect-tools row). A right rail (`Today` panel — todos / inbox / meetings)
 * mounts via `useRightRail()` when open and reads production-backed data.
 */
export interface ChatShellProps {
  threadId: string | undefined;
  title: string;
}

export function ChatShell({ threadId, title }: ChatShellProps) {
  const railMode = useRailMode();
  const [railOpen, setRailOpen] = useState(() => railMode === "inline");
  const railData = useRailData();

  // Snap the rail to each mode's sensible default when the viewport crosses
  // the breakpoint — wide screens get the inline rail, narrow screens hide
  // the overlay so it doesn't ambush the user on resize.
  const [prevMode, setPrevMode] = useState(railMode);
  if (prevMode !== railMode) {
    setPrevMode(railMode);
    setRailOpen(railMode === "inline");
  }

  // ESC closes the overlay rail.
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

  // Artifact sidebar (ADR-0075). When the boss authors an artifact the user
  // can open it from its trigger card; the panel then takes over the shared
  // right slot (the Today rail steps aside) until closed. State is local UI —
  // the content rides the synced `artifacts` row. The panel also auto-opens the
  // freshest artifact of the live run (`activeRunId`), so the shell doesn't have
  // to push synced ids into it from an effect.
  //
  // The live artifact stream fills a `document` body token-by-token while the
  // boss authors it — before the durable row syncs (create) or as it's rewritten
  // (update/append). The panel binds a pending create by `toolCallId`; here we
  // resolve the open target's live body to hand the sidebar.
  const artifactStream = useArtifactStream(threadId);
  const artifact = useArtifactPanel(threadId, activeRunId, artifactStream);
  const liveArtifact = useMemo(() => {
    if (!artifact.selectedId) return null;
    const pendingTcid = pendingToolCallId(artifact.selectedId);
    return pendingTcid
      ? artifactStream.byToolCallId(pendingTcid)
      : artifactStream.byArtifactId(artifact.selectedId);
  }, [artifact.selectedId, artifactStream]);

  // "Suggest an edit" from the sidebar prefills the composer (ADR-0075 Phase 4):
  // a nonce makes the same scaffold re-apply if requested twice, and the main
  // Composer consumes it via an effect (see `prefill`). The prefill is tagged
  // with the thread it was created for so a stale prefill doesn't leak into a
  // different thread's composer when the user navigates away (the Composer
  // remounts per-thread, which would otherwise re-fire the apply effect).
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

  // Memoize the rail node so `useRightRail`'s effect only fires when the
  // rail's inputs actually change — otherwise every ChatShell re-render
  // would push a new JSX reference into AppShell and trigger an extra
  // AppShell re-render.
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
  // One shell slot, two occupants: the artifact panel wins while open.
  useRightRail(artifactNode ?? railNode);

  const send = useSendMessage();
  // Model tier from the composer's picker (Auto vs Deep). Persisted so the
  // choice survives reloads and thread switches; rides with every turn.
  const [tier, setTier] = useModelTier();
  const onSend = useCallback(
    (text: string, files?: File[], artifactTargetId?: string) =>
      send(threadId, text, tier, files, undefined, undefined, artifactTargetId),
    [send, threadId, tier],
  );
  // Retry re-sends the prior user turn as a fresh turn. It carries that
  // message's attachment ids (not File objects — the bytes are already in the
  // bucket); the server copies them onto the new message. This is what lets an
  // image-only failed turn be retried (ADR-0065).
  const onRetry = useCallback(
    (text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) =>
      void send(threadId, text, tier, undefined, retryAttachmentIds, retryAttachmentMessageId),
    [send, threadId, tier],
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

  // Chat "Auto" mode flips the user's global approval default
  // (`user_action_policies.defaultMode`). On `autonomy` the dispatcher runs
  // tools without staging a gated approval, so no tray card ever appears —
  // server-authoritative, no per-action flicker. This is a global switch (it
  // also governs triage/briefing/workflows), and per-integration rules set in
  // Settings still override it.
  const { policy, setDefaultMode, loading: policyLoading } = useActionPolicy();
  const autoApprove = policy?.defaultMode === "autonomy";
  const autoApprovePending = policyLoading;
  const onToggleAutoApprove = useCallback(() => {
    // Wait for the subscription to settle, then let the server mutator upsert
    // the baseline row if this is a legacy user without a synced policy yet.
    if (policyLoading) return;
    void setDefaultMode(autoApprove ? "gated" : "autonomy");
  }, [autoApprove, policyLoading, setDefaultMode]);

  // Follow-up suggestions for the last completed reply. We commit to a single
  // affordance per reply to avoid the split-brain of a ghosted prompt competing
  // with chips: exactly one suggestion → composer ghost text (Tab to accept);
  // two or more → all render as equal-weight chips, no ghost.
  const followUps = useMemo(
    () => (showStream ? [] : buildFollowUpSuggestions(messages)),
    [messages, showStream],
  );
  const chipFollowUps = useMemo(() => (followUps.length >= 2 ? followUps : []), [followUps]);
  const lastMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null;
  // Ghost dismissal is per-reply: accepting or Escaping hides it until the
  // next assistant message produces a fresh suggestion.
  const [ghostDismissedFor, setGhostDismissedFor] = useState<string | null>(null);
  const ghostSuggestion = followUps.length === 1 ? followUps[0] : undefined;
  const ghostText =
    ghostSuggestion && ghostDismissedFor !== lastMessageId ? ghostSuggestion.text : undefined;
  const onGhostDone = useCallback(() => setGhostDismissedFor(lastMessageId), [lastMessageId]);

  // Stop the in-flight turn (composer stop button). We freeze the bubble and
  // swap the composer back to send *this frame* via `stopStream()`, then fire
  // the server stop best-effort — the worker notices the Redis flag and
  // finalizes the partial reply, which reconciles through the normal
  // `chat.message completed` / Replicache sync. Decoupling the UI from that
  // ~400ms round-trip is what makes stop feel instant.
  const onStopGeneration = useCallback(() => {
    if (!activeRunId) return;
    stopStream();
    void stopChatRun(activeRunId).then((ok) => {
      if (!ok) toast.error("Couldn't stop the reply. Please try again.");
    });
  }, [activeRunId, stopStream]);

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="relative flex h-full min-w-0 flex-col">
        <TopBar
          title={title}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
          artifacts={artifact.artifacts}
          selectedArtifactId={artifact.selectedId}
          onOpenArtifact={artifact.open}
          onCloseArtifact={artifact.close}
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
              hasPendingApproval={hasPendingApproval}
            />
            <div className="shrink-0 px-4 pb-4">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                <ChatApprovalTray
                  runId={activeRunId}
                  approvals={runApprovals}
                  awaitingApproval={awaitingApproval}
                />
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
