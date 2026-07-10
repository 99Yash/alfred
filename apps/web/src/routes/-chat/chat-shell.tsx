import {
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  isRecord,
  scoreAttentionForItems,
  type AttentionBand,
  type TriageCategory,
} from "@alfred/contracts";
import type { SyncedTodo, SyncedTriageTag } from "@alfred/sync";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Link } from "@tanstack/react-router";
import type { JSONContent } from "@tiptap/react";
import {
  ArrowUp,
  AtSign,
  Check,
  Ellipsis,
  Loader2,
  Mic,
  PanelLeft,
  PanelRight,
  Paperclip,
  Share2,
  ShieldCheck,
  Square,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useAppTheme } from "~/components/ui/v2/theme";
import { INBOX_PAGE_SIZE, useInbox, useMarkInboxRead, type InboxPage } from "~/hooks/use-inbox";
import { useResolvedIntegrations } from "~/hooks/use-integration-status";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
import { useMeetings } from "~/hooks/use-meetings";
import { useRunBriefing } from "~/hooks/use-run-briefing";
import { authClient } from "~/lib/auth/auth-client";
import { stopChatRun, transcribeRecording } from "~/lib/chat/turn-controls";
import { ACCEPT_ATTR, validateFile } from "~/lib/chat/upload-attachments";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { useRunComplete } from "~/lib/chat/use-run-complete";
import { useSendMessage } from "~/lib/chat/use-send-message";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { PROVIDER_BACKEND } from "~/lib/integrations/integrations";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { useChatMessages } from "~/lib/replicache/use-chat";
import { useTodos } from "~/lib/replicache/use-todos";
import { useTriageTags } from "~/lib/replicache/use-triage-tags";
import { useRightRail, useSidebarState } from "~/lib/shell/app-shell";
import {
  getLocalStorageItem,
  safeGet,
  safeRemove,
  safeSet,
  setLocalStorageItem,
} from "~/lib/storage/storage";
import { toast } from "~/lib/toast";
import { firstName, greeting } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import type { InboxItem, TodoItem } from "~/routes/-preview-chat/helpers";
import { useRailMode } from "~/routes/-preview-chat/helpers";
import { IconButton } from "~/routes/-preview-chat/icon-button";
import { EMPTY_RAIL_DATA, type RailData } from "~/routes/-preview-chat/rail-data";
import { RightRail } from "~/routes/-preview-chat/right-rail";
import type { SuggestionInput } from "~/routes/-preview-chat/todo-feed";
import { ChatApprovalTray } from "./approval-tray";
import { ArtifactSidebar, type ArtifactEditSuggestion } from "./artifact-sidebar";
import { Conversation } from "./conversation";
import { buildFollowUpSuggestions, shouldShowStream } from "./conversation-helpers";
import { filterMentionOptions, type MentionOption } from "./mention-options";
import { MicWaveform, useMicRecording } from "./mic-recording";
import { formatElapsed } from "./mic-recording-format";
import { ModelTierPicker, type ChatTier } from "./model-tier-picker";
import { Tip } from "./tip";
import {
  TiptapComposer,
  type SuggestionRenderState,
  type TiptapComposerHandle,
} from "./tiptap-composer";
import { useArtifactPanel } from "./use-artifact-panel";

// Module-level empties so the `?? EMPTY` fallback in `useRailData` returns a
// referentially stable value before react-query's first fetch resolves —
// otherwise every downstream callback / memo would churn on each render.
const EMPTY_INBOX_PAGES: ReadonlyArray<InboxPage> = [];
const EMPTY_INBOX_ITEMS: ReadonlyArray<InboxItem> = [];

/**
 * Fixture-free chat scaffold shared by `/chat` and `/chat/$threadId`.
 *
 * Top bar with the thread title + action buttons (share, more, rail toggle).
 * Below: a centered empty-state hero (date · greeting · tagline · composer ·
 * connect-tools row). A right rail (`Today` panel — todos / inbox / meetings)
 * mounts via `useRightRail()` when open; the rail UI is reused from the
 * `/preview/chat` source dir today, so its content is fixture data until
 * Replicache wires real per-user todos/inbox/meetings in m13.
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
  const prevModeRef = useRef(railMode);
  if (prevModeRef.current !== railMode) {
    prevModeRef.current = railMode;
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

  const messages = useChatMessages(threadId);
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
  const artifact = useArtifactPanel(threadId, activeRunId);

  // "Suggest an edit" from the sidebar prefills the composer (ADR-0075 Phase 4):
  // a nonce makes the same scaffold re-apply if requested twice, and the main
  // Composer consumes it via an effect (see `prefill`). The prefill is tagged
  // with the thread it was created for so a stale prefill doesn't leak into a
  // different thread's composer when the user navigates away (the Composer
  // remounts per-thread, which would otherwise re-fire the apply effect).
  const [editPrefill, setEditPrefill] = useState<{
    artifactTargetId: string;
    text: string;
    nonce: number;
    threadId: string | undefined;
  } | null>(null);
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
          mode={railMode}
          width={artifact.width}
          onWidthChange={artifact.setWidth}
          onClose={artifact.close}
          onSuggestEdit={onSuggestArtifactEdit}
        />
      ) : null,
    [
      artifact.selectedId,
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
  const approvalTrayActive = awaitingApproval || runApprovals.length > 0;
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
    if (autoApprovePending) return;
    void setDefaultMode(autoApprove ? "gated" : "autonomy");
  }, [autoApprove, autoApprovePending, setDefaultMode]);

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
        <TopBar title={title} railOpen={railOpen} onToggleRail={() => setRailOpen((v) => !v)} />
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

function TopBar({
  title,
  railOpen,
  onToggleRail,
}: {
  title: string;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarState();
  return (
    <header
      className={cn(
        "app-frost-header sticky top-0 z-10",
        "flex h-14 shrink-0 items-center justify-between gap-3 px-5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen ? (
          <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={14} />
          </IconButton>
        ) : null}
        <h1 className="truncate text-sm font-medium text-app-fg-4">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5">
        <Tip label="Share thread">
          <IconButton label="Share thread">
            <Share2 size={14} />
          </IconButton>
        </Tip>
        <Tip label="Thread settings">
          <IconButton label="Thread settings">
            <Ellipsis size={14} />
          </IconButton>
        </Tip>
        <span aria-hidden className="mx-1 h-5 w-px bg-app-bg-3" />
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
    </header>
  );
}

function EmptyHero({
  threadId,
  isStreaming,
  onSend,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  onSend?: (text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const { data: session } = authClient.useSession();
  const name = firstName(session?.user);
  const now = new Date();

  // Cluster greeting + composer + connect-tools as a single block centered
  // in the remaining viewport. flex-col + justify-center keeps the group
  // tight whether the column is 600px or 1000px tall.
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center">
        <p className="text-[11px] font-medium tracking-tight text-app-fg-2 uppercase">
          {formatDate(now)}
        </p>
        <h2 className="mt-3 text-center text-3xl font-medium tracking-[-0.04em] text-app-fg-4 md:text-4xl">
          {greeting(now)}
          {name ? <span className="text-app-fg-3">, {name}</span> : null}
        </h2>
      </div>

      {/* Composer + connect-tools shelf share a column so the shelf reads
       * as part of the same affordance — the composer flattens its bottom
       * edge and the shelf tucks under it, slightly inset. Mirrors
       * dimension's `ConnectIntegrationsBar` pattern. */}
      <div className="mt-8 w-full max-w-2xl">
        {/* Key by threadId so the composer (and its Tiptap editor) remounts
         * on thread switch — draft-seeding from localStorage runs once per
         * thread and the editor instance starts fresh, no per-render sync. */}
        <Composer
          key={threadId ?? "new"}
          threadId={threadId}
          isStreaming={isStreaming}
          onSend={onSend}
          autoApprove={autoApprove}
          autoApprovePending={autoApprovePending}
          onToggleAutoApprove={onToggleAutoApprove}
          tier={tier}
          onTierChange={onTierChange}
        />
        <ConnectToolsBar />
      </div>
    </div>
  );
}

function MentionPalette({
  options,
  activeIdx,
  onHover,
  onPick,
  onClose,
}: {
  options: ReadonlyArray<MentionOption>;
  activeIdx: number;
  onHover: (i: number) => void;
  onPick: (option: MentionOption) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside the palette closes it. Pointerdown beats pointerup so the
  // click never lands on whatever's underneath.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      // Don't close on clicks inside the palette, or inside the composer
      // form (the textarea is the trigger surface — clicking it should
      // keep the palette open so the user can continue typing).
      if (target && (root.contains(target) || root.closest("form")?.contains(target))) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [onClose]);

  // Scroll the active row into view as soon as React attaches its DOM node.
  // Wiring this through a ref callback (instead of a useEffect on activeIdx)
  // means the scroll fires from the same render that swapped the active
  // option — no extra render-then-effect step — and only when the active
  // node identity actually changes. `block: "nearest"` is a no-op once the
  // row is visible, so the list doesn't twitch on hover.
  const scrollActiveIntoView = useCallback((el: HTMLButtonElement | null) => {
    if (el) el.scrollIntoView({ block: "nearest" });
  }, []);

  const labelId = "mention-palette-label";
  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute right-0 bottom-full left-0 z-20 mb-2",
        "app-elevated rounded-2xl bg-app-bg-1 p-1.5",
        "max-h-72 overflow-y-auto",
        // Subtle entry — slide up + fade. Tailwind's `animate-in` keyframes
        // ship with the project (used elsewhere as `app-card-in`); fall back
        // to a plain fade so it never appears static.
        "transition-opacity duration-150 ease-out",
      )}
    >
      <p
        id={labelId}
        className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-tight text-app-fg-2 uppercase"
      >
        Mention a source
      </p>
      {/* `role="menu"` rather than `role="listbox"` here is a deliberate
       * compromise: react-doctor's prefer-tag-over-role maps listbox →
       * <datalist> (no rich rows possible) and <ul role="listbox"> trips
       * no-noninteractive-element-to-interactive-role. Semantically the
       * palette is a popup the user picks one item from — `menu` /
       * `menuitem` cover that and don't conflict with either rule. */}
      <div role="menu" aria-labelledby={labelId}>
        {options.map((opt, i) => {
          const Icon = opt.icon;
          const isActive = i === activeIdx;
          return (
            <button
              key={opt.value}
              ref={isActive ? scrollActiveIntoView : null}
              type="button"
              role="menuitem"
              aria-current={isActive ? "true" : undefined}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(opt)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left",
                "transition-colors",
                isActive ? "bg-app-bg-a2" : "hover:bg-app-bg-a2",
                "outline-none",
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-app-bg-2">
                {opt.brand ? (
                  <IntegrationGlyph brand={opt.brand} size={14} />
                ) : Icon ? (
                  <Icon size={13} className="text-app-fg-3" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-app-fg-4">
                  {opt.label}
                </span>
                <span className="block truncate text-[11px] text-app-fg-2">{opt.subtitle}</span>
              </span>
              {isActive ? (
                <span className="rounded bg-app-bg-2 px-1.5 py-0.5 text-[10px] text-app-fg-2 tabular-nums">
                  ↵
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConnectToolsBar() {
  // Drive the row off the real catalog overlaid with live credential state
  // instead of a hardcoded brand list. Catalog-only providers stay on the
  // integrations page, but this nudge only shows providers the user can
  // actually connect here.
  const integrations = useResolvedIntegrations();

  // Unconnected first (these are the actual nudge), connected trailing with
  // a check. Catalog order is preserved within each group.
  const ordered = useMemo(() => {
    const visible = integrations.filter(
      (p) => p.status === "connected" || PROVIDER_BACKEND[p.id] !== undefined,
    );
    const unconnected = visible.filter((p) => p.status !== "connected");
    const connected = visible.filter((p) => p.status === "connected");
    return { unconnected, connected, all: [...unconnected, ...connected] };
  }, [integrations]);

  // Everything actionable in this row is already connected, so drop the nudge.
  if (ordered.unconnected.length === 0) return null;

  return (
    <Link
      to="/integrations"
      aria-label="Connect your tools"
      className={cn(
        // No card, no fill, no divider — just a tappable row floating
        // below the composer. Mirrors dimension's `00-chat-new-initial`
        // reference: label on the left, icons on the right, page bg
        // showing through.
        "group mt-4 flex items-center gap-3 px-1.5",
        "rounded-md outline-none",
        "focus-visible:ring-2 focus-visible:ring-app-purple-2",
        "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
      )}
    >
      <span
        className={cn(
          "text-[13px] font-medium text-app-fg-2",
          "transition-colors duration-200 group-hover:text-app-fg-4",
        )}
      >
        Connect your tools
      </span>

      {/* Overlapping stack: each glyph sits on its own tile ringed in the
       * page background, so a slight negative margin reads as a clean
       * "cut-out" overlap rather than a collision. Connected tiles lift
       * above their neighbours (z-10) so their check badge stays visible;
       * the hovered tile floats above everything (z-20). */}
      <div className="ml-auto flex items-center">
        {ordered.all.map((p, i) => {
          const connected = p.status === "connected";
          return (
            <Tip key={p.id} label={connected ? `${p.name} — connected` : p.name}>
              <span
                className={cn(
                  "relative grid size-[22px] shrink-0 place-items-center rounded-full",
                  "bg-app-bg-2 ring-2 ring-app-background",
                  i > 0 && "-ml-1.5",
                  "transition-transform duration-200 ease-out hover:z-20 hover:scale-110",
                  connected ? "z-10" : "",
                )}
              >
                <span className="sr-only">{connected ? `${p.name}, connected` : p.name}</span>
                <IntegrationGlyph
                  brand={p.brand}
                  size={14}
                  className={cn(
                    "transition-opacity duration-200",
                    connected ? "opacity-100" : "opacity-70 group-hover:opacity-100",
                  )}
                />
                {connected ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center",
                      "rounded-full bg-emerald-400 text-black",
                      "ring-2 ring-app-background",
                    )}
                  >
                    <Check size={7} strokeWidth={3.5} />
                  </span>
                ) : null}
              </span>
            </Tip>
          );
        })}
      </div>
    </Link>
  );
}

function Composer({
  threadId,
  isStreaming,
  disabled = false,
  onSend,
  onStopGeneration,
  ghostText,
  onGhostAccept,
  onGhostDismiss,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
  prefill,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  disabled?: boolean;
  onSend?: (text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>;
  onStopGeneration?: () => void;
  /**
   * Text to drop into the editor on demand (e.g. the artifact sidebar's
   * "Suggest an edit"). The `nonce` lets the same scaffold re-apply on a repeat
   * request; the editor inserts it at the caret and focuses (ADR-0075 Phase 4).
   */
  prefill?: {
    artifactTargetId: string;
    text: string;
    nonce: number;
    threadId: string | undefined;
  } | null;
  /** Suggested next prompt shown dimmed in the empty editor; Tab accepts. */
  ghostText?: string;
  onGhostAccept?: () => void;
  onGhostDismiss?: () => void;
  /** Chat "Auto" mode state + toggle; absent hides the control. */
  autoApprove?: boolean;
  /** Initial policy load hasn't resolved yet — disable the toggle until we
   *  know the current mode (the row may not exist; clicking creates it). */
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  /** Model-tier picker (Auto vs Deep) state + setter. */
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const { resolved: theme } = useAppTheme();
  const editorRef = useRef<TiptapComposerHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { initialJSON, text, isEmpty, onEditorChange, resetDraft } = useComposerDraft(threadId);
  const voice = useComposerVoice(editorRef);
  const mention = useMentionController();
  const attachments = useComposerAttachments();
  const { mic, transcribing, voiceError, onVoiceStart, onVoiceConfirm } = voice;
  const { suggestion, mentionCandidates, visibleMentionIdx, suggestionKeyDownRef } = mention;
  const hasAttachments = attachments.items.length > 0;
  const [sending, setSending] = useState(false);
  const artifactTargetKey = `alfred:chat-artifact-target:${threadId ?? "new"}`;
  const [artifactTargetId, setArtifactTargetIdState] = useState<string | undefined>(() => {
    // Target metadata belongs to the persisted draft. Ignore a stale key when
    // no draft survived (for example, after a crash between the two removals).
    if (!initialJSON) return undefined;
    return safeGet(artifactTargetKey) ?? undefined;
  });
  const setArtifactTargetId = useCallback(
    (targetId: string | undefined) => {
      setArtifactTargetIdState(targetId);
      if (targetId) safeSet(artifactTargetKey, targetId);
      else safeRemove(artifactTargetKey);
    },
    [artifactTargetKey],
  );
  const composerDisabled = disabled || sending;
  const canSend =
    !composerDisabled &&
    !sending &&
    (!isEmpty || hasAttachments) &&
    !mic.recording &&
    !isStreaming &&
    !transcribing;

  const insertAtTrigger = useCallback(() => {
    if (composerDisabled) return;
    editorRef.current?.insertAtTrigger();
  }, [composerDisabled]);

  useTypeAnywhere(editorRef, composerDisabled);

  // Apply a "Suggest an edit" prefill from the artifact sidebar. Keyed on the
  // nonce so the same scaffold re-applies on a repeat click; `insertText`
  // focuses the editor at the caret. Skipped while the composer is disabled
  // (pending approval) so we don't fight a parked turn.
  const appliedPrefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || composerDisabled) return;
    // Ignore a prefill created for a different thread — the Composer remounts
    // per-thread, so without this a stale prefill would re-apply after the user
    // navigates away from the thread it was requested in.
    if (prefill.threadId !== threadId) return;
    if (appliedPrefillNonce.current === prefill.nonce) return;
    appliedPrefillNonce.current = prefill.nonce;
    setArtifactTargetId(prefill.artifactTargetId);
    editorRef.current?.insertText(prefill.text);
  }, [prefill, composerDisabled, threadId, setArtifactTargetId]);

  const handleEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      onEditorChange(nextText, nextJSON, nextEmpty);
      if (nextEmpty) setArtifactTargetId(undefined);
    },
    [onEditorChange, setArtifactTargetId],
  );

  const onAttachClick = useCallback(() => {
    if (composerDisabled || mic.recording) return;
    fileInputRef.current?.click();
  }, [composerDisabled, mic.recording]);

  const handleSubmit = useCallback(() => {
    if (!canSend || !onSend) return;
    const value = text.trim();
    const files = attachments.files();
    setSending(true);
    void onSend(value, files, artifactTargetId)
      .then((staged) => {
        if (!staged) return;
        editorRef.current?.clear();
        resetDraft();
        attachments.clear();
        setArtifactTargetId(undefined);
      })
      .catch(() => toast.error("Couldn't send your message. Please try again."))
      .finally(() => setSending(false));
  }, [canSend, text, onSend, resetDraft, attachments, artifactTargetId, setArtifactTargetId]);

  const onFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit();
  };

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      if (composerDisabled) return;
      attachments.addFiles(e.dataTransfer.files);
    },
    [composerDisabled, attachments],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length === 0) return;
      // Only intercept when the clipboard carries files (pasted image); let
      // normal text paste fall through to the editor.
      e.preventDefault();
      if (composerDisabled) return;
      attachments.addFiles(files);
    },
    [composerDisabled, attachments],
  );

  return (
    <form
      onSubmit={onFormSubmit}
      aria-label="Send a message"
      data-disabled={composerDisabled || undefined}
      className="relative"
    >
      {!composerDisabled && suggestion && mentionCandidates.length > 0 ? (
        <MentionPalette
          options={mentionCandidates}
          activeIdx={visibleMentionIdx}
          onHover={mention.setMentionIdx}
          onPick={mention.insertMention}
          onClose={() => suggestion.dismiss()}
        />
      ) : null}
      <div
        className={cn(
          "app-elevated relative overflow-hidden rounded-3xl p-2",
          // Transparent surface — particles + the app-elevated hairline carry
          // the composer's visual identity now, no solid fill needed.
          // Light mode gets a stronger inset ring on top of app-elevated's 0.05
          // hairline so the edge reads against the white page; dark relies on
          // app-elevated's existing inset white ring.
          theme === "light" && "ring-1 ring-app-fg-a1/50 ring-inset",
          "focus-within:ring-2 focus-within:ring-app-purple-2 focus-within:ring-offset-4",
          "transition-shadow focus-within:ring-offset-app-background",
          disabled && "opacity-70",
          sending && "opacity-80",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        {/* Wrap editor + controls in a positioned container so they paint
         * above the absolutely-positioned particles canvas (positioned
         * siblings with z-auto paint in tree order). */}
        <div className="relative">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            disabled={composerDisabled}
            aria-label="Attach files"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) attachments.addFiles(e.target.files);
              // Reset so picking the same file again re-fires change.
              e.target.value = "";
            }}
          />
          {hasAttachments ? (
            <AttachmentChips
              items={attachments.items}
              disabled={composerDisabled}
              onRemove={attachments.remove}
            />
          ) : null}
          {/* Keep the editor mounted (just hidden) while recording so its
           * content survives the voice round-trip — the transcript appends to
           * whatever was already typed instead of a remount reverting to the
           * mount-time draft. */}
          <div className={cn(mic.recording && "hidden")}>
            <TiptapComposer
              ref={editorRef}
              initialJSON={initialJSON}
              placeholder="Type and press enter to start chatting…"
              disabled={composerDisabled}
              onChange={handleEditorChange}
              onSubmit={handleSubmit}
              onSuggestionChange={mention.setSuggestion}
              suggestionKeyDownRef={suggestionKeyDownRef}
              ghostText={ghostText}
              onGhostAccept={onGhostAccept}
              onGhostDismiss={onGhostDismiss}
            />
          </div>
          {mic.recording ? (
            <RecordingPanel
              levelsRef={mic.levelsRef}
              elapsed={mic.elapsed}
              active={mic.recording}
            />
          ) : null}

          <ComposerToolbar
            mic={mic}
            canSend={canSend}
            isStreaming={isStreaming}
            disabled={composerDisabled}
            sending={sending}
            mentionActive={suggestion !== null}
            onMentionClick={insertAtTrigger}
            onAttachClick={onAttachClick}
            transcribing={transcribing}
            voiceError={voiceError}
            onVoiceStart={onVoiceStart}
            onVoiceConfirm={() => void onVoiceConfirm()}
            onStopGeneration={onStopGeneration}
            autoApprove={autoApprove}
            autoApprovePending={autoApprovePending}
            onToggleAutoApprove={onToggleAutoApprove}
            tier={tier}
            onTierChange={onTierChange}
          />
        </div>
      </div>
    </form>
  );
}

/** A file staged in the composer, with a local preview, before send. */
interface PendingAttachment {
  /** Local key for React + removal; the real attachment id is minted at upload. */
  key: string;
  file: File;
  /** Object URL for the inline preview thumbnail; revoked on removal/clear. */
  previewUrl: string;
}

interface ComposerAttachments {
  items: PendingAttachment[];
  addFiles: (files: FileList | File[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** The raw files, in staged order, for the send handler. */
  files: () => File[];
}

/**
 * Composer-local attachment staging (ADR-0065). Holds picked files with object-
 * URL previews until send; validation rejects unsupported/oversized files with a
 * toast. The bytes upload at send time (see `useSendMessage`), so this only
 * tracks the pending selection — object URLs are revoked on removal, clear, and
 * unmount to avoid leaks.
 */
function useComposerAttachments(): ComposerAttachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Cap the staged count/bytes *before* upload — the turn endpoint and server
  // mutator also enforce the caps, but bounding here means a user picking 11
  // images never uploads the 11th only to have the turn rejected. All revocation
  // + toasts happen here in the event handler (against the live `itemsRef`), so
  // the `setItems` updater stays pure — React can double-invoke updaters under
  // StrictMode, and revoking inside one would kill a preview that's still in use.
  const addFiles = useCallback((files: FileList | File[]) => {
    const candidates: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const err = validateFile(file);
      if (err) {
        toast.error(err);
        continue;
      }
      candidates.push({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
    }
    if (candidates.length === 0) return;
    const current = itemsRef.current;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;
    if (room <= 0) {
      for (const a of candidates) URL.revokeObjectURL(a.previewUrl);
      toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
      return;
    }
    const accepted = candidates.slice(0, room);
    if (accepted.length < candidates.length) {
      for (const a of candidates.slice(room)) URL.revokeObjectURL(a.previewUrl);
      toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
    }
    const acceptedBytes = accepted.reduce((sum, item) => sum + item.file.size, 0);
    const totalBytes = current.reduce((sum, item) => sum + item.file.size, 0) + acceptedBytes;
    if (totalBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
      for (const a of accepted) URL.revokeObjectURL(a.previewUrl);
      const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
      toast.error(`Attachments can be up to ${mb} MB combined.`);
      return;
    }
    setItems((prev) => [...prev, ...accepted]);
  }, []);

  const remove = useCallback((key: string) => {
    const target = itemsRef.current.find((a) => a.key === key);
    if (target) URL.revokeObjectURL(target.previewUrl);
    setItems((prev) => prev.filter((a) => a.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    setItems([]);
  }, []);

  const files = useCallback(() => itemsRef.current.map((a) => a.file), []);

  // Revoke any still-staged previews on unmount.
  useEffect(
    () => () => {
      for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  return { items, addFiles, remove, clear, files };
}

/** Inline preview row for staged attachments above the editor. */
function AttachmentChips({
  items,
  disabled,
  onRemove,
}: {
  items: PendingAttachment[];
  disabled?: boolean;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((a) => (
        <div
          key={a.key}
          className="group relative size-16 overflow-hidden rounded-xl border border-app-fg-a1/40 bg-app-bg-2"
        >
          <img src={a.previewUrl} alt={a.file.name} className="size-full object-cover" />
          <button
            type="button"
            aria-label={`Remove ${a.file.name}`}
            disabled={disabled}
            onClick={() => onRemove(a.key)}
            className={cn(
              "absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-app-background/80 text-app-fg-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
              disabled &&
                "cursor-not-allowed opacity-0 group-hover:opacity-0 focus-visible:opacity-0",
            )}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function useComposerDraft(threadId: string | undefined): {
  initialJSON: JSONContent | undefined;
  text: string;
  isEmpty: boolean;
  onEditorChange: (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => void;
  resetDraft: () => void;
} {
  // Persist drafts per thread (and a shared "new chat" bucket for the empty
  // /chat hero). Survives refresh; cleared on submit.
  const draftKey = `alfred:chat-draft:${threadId ?? "new"}`;

  // Seed the editor once on mount. Stored drafts are Tiptap JSON; we also
  // accept the legacy plain-string format so drafts written by the previous
  // textarea+mirror composer survive the migration.
  const initialJSON = useMemo(() => readDraftJSON(draftKey), [draftKey]);
  const [editorState, setEditorState] = useState<{
    text: string;
    isEmpty: boolean;
  }>(() => {
    const initialText = initialJSON ? extractTextFromJSON(initialJSON) : "";
    return { text: initialText, isEmpty: initialText.trim().length === 0 };
  });

  const onEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      setEditorState({ text: nextText, isEmpty: nextEmpty });
      if (nextEmpty) {
        safeRemove(draftKey);
      } else {
        safeSet(draftKey, JSON.stringify(nextJSON));
      }
    },
    [draftKey],
  );

  const resetDraft = useCallback(() => {
    setEditorState({ text: "", isEmpty: true });
    safeRemove(draftKey);
  }, [draftKey]);

  return {
    initialJSON,
    text: editorState.text,
    isEmpty: editorState.isEmpty,
    onEditorChange,
    resetDraft,
  };
}

type VoiceState = {
  transcribing: boolean;
  error: string | null;
};

type VoiceAction =
  | { type: "clear_error" }
  | { type: "transcribe_start" }
  | { type: "transcribe_success" }
  | { type: "transcribe_error"; error: string };

function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "clear_error":
      return { ...state, error: null };
    case "transcribe_start":
      return { transcribing: true, error: null };
    case "transcribe_success":
      return { transcribing: false, error: null };
    case "transcribe_error":
      return { transcribing: false, error: action.error };
  }
}

function useComposerVoice(editorRef: RefObject<TiptapComposerHandle | null>): {
  mic: ReturnType<typeof useMicRecording>;
  transcribing: boolean;
  voiceError: string | null;
  onVoiceStart: () => void;
  onVoiceConfirm: () => Promise<void>;
} {
  const mic = useMicRecording();
  const [voice, dispatchVoice] = useReducer(voiceReducer, {
    transcribing: false,
    error: null,
  });

  const onVoiceStart = useCallback(() => {
    dispatchVoice({ type: "clear_error" });
    void mic.start();
  }, [mic]);

  const onVoiceConfirm = useCallback(async () => {
    dispatchVoice({ type: "clear_error" });
    const blob = await mic.finish();
    if (!blob) {
      dispatchVoice({ type: "transcribe_error", error: "We didn't catch that. Try again." });
      return;
    }
    dispatchVoice({ type: "transcribe_start" });
    try {
      const transcript = (await transcribeRecording(blob)).trim();
      if (transcript.length === 0) {
        dispatchVoice({ type: "transcribe_error", error: "We didn't catch that. Try again." });
        return;
      }
      editorRef.current?.insertText(transcript);
      dispatchVoice({ type: "transcribe_success" });
    } catch (err) {
      dispatchVoice({
        type: "transcribe_error",
        error: err instanceof Error ? err.message : "Transcription failed. Try again.",
      });
    }
  }, [editorRef, mic]);

  return {
    mic,
    transcribing: voice.transcribing,
    voiceError: voice.error,
    onVoiceStart,
    onVoiceConfirm,
  };
}

function useMentionController(): {
  suggestion: SuggestionRenderState | null;
  setSuggestion: (state: SuggestionRenderState | null) => void;
  mentionCandidates: ReadonlyArray<MentionOption>;
  visibleMentionIdx: number;
  setMentionIdx: (idx: number) => void;
  insertMention: (option: MentionOption) => void;
  suggestionKeyDownRef: MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
} {
  // Suggestion bridge: Tiptap's mention plugin pushes lifecycle into here;
  // the palette UI reads from it.
  const [suggestion, setSuggestion] = useState<SuggestionRenderState | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionCandidates = useMemo(
    () => (suggestion ? filterMentionOptions(suggestion.query) : []),
    [suggestion],
  );

  // Reset the active index when a new suggestion opens or the query changes.
  // The previous-value-during-render pattern keeps this synchronous and out
  // of an effect. `prevQuery` is only used to gate the reset, never read in
  // JSX, so a ref avoids a parallel state cell and the extra render it'd cost.
  const currentQuery = suggestion?.query ?? null;
  const prevQueryRef = useRef<string | null>(currentQuery);
  if (prevQueryRef.current !== currentQuery) {
    prevQueryRef.current = currentQuery;
    setMentionIdx(0);
  }

  // Clamp the active row at render time. If filtering shrunk the list since
  // the last keystroke, the displayed highlight lands on the last valid row
  // without an effect that loops state back through React.
  const visibleMentionIdx =
    mentionCandidates.length === 0 ? 0 : Math.min(mentionIdx, mentionCandidates.length - 1);

  const insertMention = useCallback(
    (option: MentionOption) => {
      suggestion?.command(option);
    },
    [suggestion],
  );

  // Bridge keyboard nav into the Tiptap suggestion plugin. Returning `true`
  // tells Tiptap to swallow the key so it doesn't also reach the editor.
  const suggestionKeyDownRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  suggestionKeyDownRef.current = (event) => {
    if (!suggestion || mentionCandidates.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIdx(Math.min(mentionCandidates.length - 1, visibleMentionIdx + 1));
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIdx(Math.max(0, visibleMentionIdx - 1));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const pick = mentionCandidates[visibleMentionIdx];
      if (pick) {
        event.preventDefault();
        suggestion.command(pick);
        return true;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      suggestion.dismiss();
      return true;
    }
    return false;
  };

  return {
    suggestion,
    setSuggestion,
    mentionCandidates,
    visibleMentionIdx,
    setMentionIdx,
    insertMention,
    suggestionKeyDownRef,
  };
}

function useTypeAnywhere(
  editorRef: RefObject<TiptapComposerHandle | null>,
  disabled: boolean,
): void {
  // Type-anywhere autofocus: any printable keystroke on the page lands in
  // the composer. Skipped when the user is already inside an input / when a
  // modifier (⌘ / Ctrl / Alt) is held so app shortcuts still fire.
  useEffect(() => {
    if (disabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.key || e.key.length !== 1) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const handle = editorRef.current;
      if (!handle) return;
      e.preventDefault();
      handle.insertText(e.key);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [disabled, editorRef]);
}

function readDraftJSON(draftKey: string): JSONContent | undefined {
  const raw = safeGet(draftKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as JSONContent;
    if (isRecord(parsed) && "type" in parsed) return parsed as JSONContent;
  } catch {
    // Legacy plain-text draft — wrap as a single paragraph.
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
    };
  }
  return undefined;
}

function ComposerToolbar({
  mic,
  canSend,
  isStreaming,
  disabled,
  sending,
  mentionActive,
  onMentionClick,
  onAttachClick,
  transcribing,
  voiceError,
  onVoiceStart,
  onVoiceConfirm,
  onStopGeneration,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
}: {
  mic: ReturnType<typeof useMicRecording>;
  canSend: boolean;
  isStreaming: boolean;
  disabled: boolean;
  sending: boolean;
  mentionActive: boolean;
  onMentionClick: () => void;
  onAttachClick: () => void;
  transcribing: boolean;
  voiceError: string | null;
  onVoiceStart: () => void;
  onVoiceConfirm: () => void;
  onStopGeneration?: () => void;
  autoApprove?: boolean;
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const statusMessage = voiceError ?? mic.error;
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
      <div className="flex items-center gap-1">
        <Tip label="Attach image">
          <ComposerIcon
            label="Attach image"
            disabled={disabled || mic.recording}
            onClick={onAttachClick}
          >
            <Paperclip size={14} />
          </ComposerIcon>
        </Tip>
        <Tip label="Mention a source" keys={["@"]}>
          <ComposerIcon
            label="Mention a source"
            disabled={disabled || mic.recording}
            onClick={onMentionClick}
            active={!disabled && mentionActive}
          >
            <AtSign size={14} />
          </ComposerIcon>
        </Tip>
        <ModelTierPicker
          value={tier}
          onChange={onTierChange}
          disabled={disabled || mic.recording}
        />
        {onToggleAutoApprove ? (
          <AutoApproveToggle
            on={Boolean(autoApprove)}
            disabled={Boolean(autoApprovePending)}
            onToggle={onToggleAutoApprove}
          />
        ) : null}
        {transcribing ? (
          <span className="animate-chat-shimmer pl-1 text-[11px] text-app-fg-3">Transcribing…</span>
        ) : statusMessage ? (
          <span className="pl-1 text-[11px] text-app-red-4">{statusMessage}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {mic.recording ? (
          <>
            {/* Voice mode: X discards the take, ✓ sends it to transcription. */}
            <Tip label="Discard recording">
              <ComposerIcon label="Discard recording" onClick={mic.cancel}>
                <X size={14} />
              </ComposerIcon>
            </Tip>
            <Tip label="Use recording">
              <button
                type="button"
                onClick={onVoiceConfirm}
                aria-label="Use recording"
                className={cn(
                  "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                  "app-press transition-[opacity,filter,transform]",
                  "hover:scale-[1.04] active:scale-[0.97]",
                  "text-(--app-accent-fg)",
                  "bg-(image:--app-cta-bg)",
                  "shadow-(--app-button-primary-shadow)",
                  "hover:brightness-[1.06]",
                  "hover:shadow-(--app-button-primary-shadow-hover)",
                  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                  "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                )}
              >
                <Check size={16} strokeWidth={2.5} />
              </button>
            </Tip>
          </>
        ) : (
          <>
            <Tip label="Dictate">
              <ComposerIcon
                label="Dictate"
                onClick={onVoiceStart}
                disabled={disabled || transcribing}
              >
                {transcribing ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
              </ComposerIcon>
            </Tip>
            {isStreaming && onStopGeneration ? (
              <Tip label="Stop generating">
                <button
                  type="button"
                  onClick={onStopGeneration}
                  aria-label="Stop generating"
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    "app-press transition-[opacity,filter,transform]",
                    "bg-app-red-4 text-white",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_rgba(255,47,0,0.32)]",
                    "hover:brightness-[1.05]",
                    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                    "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                  )}
                >
                  <Square size={12} strokeWidth={2.5} fill="currentColor" />
                </button>
              </Tip>
            ) : (
              <Tip label="Send" keys={["↵"]}>
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label={
                    sending
                      ? "Sending"
                      : disabled
                        ? "Waiting for approval"
                        : isStreaming
                          ? "Waiting for response"
                          : "Send"
                  }
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    "app-press transition-[opacity,filter,transform]",
                    "active:scale-[0.97] enabled:hover:scale-[1.04]",
                    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                    "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                    canSend
                      ? cn(
                          "text-(--app-accent-fg)",
                          "bg-(image:--app-cta-bg)",
                          "shadow-(--app-button-primary-shadow)",
                          "hover:brightness-[1.06]",
                          "hover:shadow-(--app-button-primary-shadow-hover)",
                        )
                      : "cursor-not-allowed bg-app-bg-2 text-app-fg-2",
                  )}
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </button>
              </Tip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Autopilot/Review toggle. On (Autopilot) → Alfred acts without pausing for
 * approval (emerald, Zap); off (Review) → it pauses before each action (Shield).
 * Distinct from the model-tier picker's "Auto" — this governs autonomy, not the
 * model. Backed by the
 * user's global `user_action_policies.defaultMode`, so it's not chat-only — it
 * governs every surface, and per-integration rules in Settings still override
 * it. Stays interactive while the composer is disabled by a pending approval so
 * flipping it on lets the parked run continue. Mirrors the Zap=autonomy /
 * Shield=gated language on the integrations policy card.
 */
function AutoApproveToggle({
  on,
  disabled,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Tip
      label={on ? "Autopilot on" : "Review on"}
      description={
        on
          ? "Alfred acts without pausing for approval."
          : "Alfred pauses for your approval before acting."
      }
    >
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium",
          "app-press transition-[box-shadow,color,background] outline-none",
          "focus-visible:ring-2 focus-visible:ring-app-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          on
            ? cn(
                // Autopilot on — green radial glow pooling from the lower-left,
                // over the tinted fill, hairline green ring. Mirrors dimension's
                // lit neumorphic toggle.
                "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]",
                "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-green-3)_28%,transparent)_0%,transparent_68%),var(--app-green-1)]",
              )
            : cn(
                // Review off — raised frosted pill, same chrome as the model pill.
                "bg-linear-to-b from-app-bg-1 to-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
                "enabled:hover:text-app-fg-4 enabled:hover:shadow-(--app-shadow-elevated-hover)",
              ),
        )}
      >
        {on ? <Zap size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
        {on ? "Autopilot" : "Review"}
      </button>
    </Tip>
  );
}

function RecordingPanel({
  levelsRef,
  elapsed,
  active,
}: {
  levelsRef: RefObject<Float32Array>;
  elapsed: number;
  active: boolean;
}) {
  return (
    <div className="relative flex h-[64px] items-center gap-3 px-3 pt-2 pb-1.5">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-tight text-app-fg-3 uppercase">
        <span aria-hidden className="chat-rec-dot size-1.5 rounded-full bg-app-red-4" />
        <span className="text-app-fg-4 tabular-nums">{formatElapsed(elapsed)}</span>
        <span className="text-app-fg-2">Listening</span>
      </span>
      <div className="h-12 flex-1">
        <MicWaveform levelsRef={levelsRef} active={active} />
      </div>
    </div>
  );
}

function ComposerIcon({
  label,
  children,
  disabled,
  onClick,
  active,
  ref,
  ...rest
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={onClick ? Boolean(active) : undefined}
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full",
        "app-press transition-colors",
        active
          ? "bg-app-purple-1 text-app-purple-4"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-app-fg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {children}
    </button>
  );
}

/* ----------- helpers ----------- */

/**
 * Model-tier selection (Auto vs Deep) persisted to localStorage, so the choice
 * is sticky across reloads and thread switches. Single-user, so this is a plain
 * local preference — no synced user-row field yet (a multi-device follow-up).
 * Backed by the typed `alfred.chat.tier` key in the storage registry, so the
 * value is schema-validated on read/write and can't drift from the tier union.
 */
function useModelTier(): [ChatTier, (tier: ChatTier) => void] {
  const [tier, setTierState] = useState<ChatTier>(() => getLocalStorageItem("alfred.chat.tier"));
  const setTier = useCallback((next: ChatTier) => {
    setTierState(next);
    setLocalStorageItem("alfred.chat.tier", next);
  }, []);
  return [tier, setTier];
}

/**
 * Builds the `RailData` bundle that drives the right rail's three tabs
 * + footer CTA.
 *
 * - Inbox → `/api/me/inbox` (real Gmail data; empty when Gmail isn't
 *   connected).
 * - Meetings → `/api/me/meetings` (real Calendar data; empty when
 *   Calendar isn't connected).
 * - Latest briefing → `/api/me/briefings/latest` (drives the footer
 *   CTA's subtitle).
 *
 * Todos stays empty — there's no schema yet — which surfaces the honest
 * "add one" empty state in `TodoFeed`.
 */
function useRailData(): RailData {
  const inbox = useInbox();
  const meetings = useMeetings();
  // On-demand briefing: `composing` drives the footer's "Composing…" state
  // and turns on polling so the chip flips to the live briefing when the run
  // lands. The latest endpoint also reports failed rows, so failure clears
  // the spinner instead of stranding the CTA.
  const [composing, setComposing] = useState(false);
  const briefing = useLatestBriefing({ poll: composing });
  const runBriefing = useRunBriefing();
  const briefingStatus = briefing.data?.status;
  useEffect(() => {
    if (!composing) return;
    if (
      briefingStatus === "sent" ||
      briefingStatus === "suppressed" ||
      briefingStatus === "failed"
    ) {
      setComposing(false);
      if (briefingStatus === "failed") {
        toast.error({
          message: "Briefing failed",
          description: "The run stopped before it could send. You can try again.",
        });
      }
    }
  }, [composing, briefingStatus]);
  const onGenerateBriefing = useCallback(() => {
    runBriefing.mutate(undefined, {
      onSuccess: (data) => {
        if (data.status === "queued" || data.status === "running") setComposing(true);
      },
      onError: (error) => {
        setComposing(false);
        toast.error({
          message: "Briefing did not start",
          description: error.message,
        });
      },
    });
  }, [runBriefing]);

  // Live todos + Alfred's suggestions (ADR-0050), Replicache-synced.
  const {
    todos: liveTodos,
    suggestions: liveSuggestions,
    createTodo,
    completeTodo,
    reopenTodo,
    completeSuggestion,
    promoteTodo,
    dismissTodo,
    clearTodo,
  } = useTodos();
  const todoItems = useMemo(() => liveTodos.map(toRailTodoItem), [liveTodos]);
  // Dismissing a suggestion hides it immediately and only commits the
  // (terminal) `dismissed` mutation after the undo window closes — so "Undo"
  // is a local cancel, not a server round-trip (`dismissed` rows never sync
  // back, so there'd be nothing to restore).
  const { hiddenSuggestionIds, onDismissSuggestion } = useSuggestionDismissal(
    liveSuggestions,
    dismissTodo,
  );
  const todoSuggestions = useMemo(() => {
    const visible: SuggestionInput[] = [];
    for (const suggestion of liveSuggestions) {
      if (!hiddenSuggestionIds.has(suggestion.id)) visible.push(toRailSuggestion(suggestion));
    }
    return visible;
  }, [liveSuggestions, hiddenSuggestionIds]);
  const onToggleTodo = useCallback(
    (id: string, done: boolean) => void (done ? reopenTodo(id) : completeTodo(id)),
    [reopenTodo, completeTodo],
  );
  const onClearTodo = useCallback((id: string) => void clearTodo(id), [clearTodo]);
  const onCreateTodo = useCallback((title: string) => void createTodo(title), [createTodo]);
  const onCompleteSuggestion = useCallback(
    (id: string) => void completeSuggestion(id),
    [completeSuggestion],
  );
  const onPromoteSuggestion = useCallback((id: string) => void promoteTodo(id), [promoteTodo]);
  const { tagsByThreadId, overrideTag } = useTriageTags();

  // Local page index walks the cached `inbox.data.pages[]`. When the user
  // advances past the last loaded page we kick off `fetchNextPage`; back
  // navigation is free because the pages stay in cache.
  const [inboxPageIndex, setInboxPageIndex] = useState(0);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);

  // Stabilize array references — react-query keeps `data.pages` stable via
  // structural sharing, but the `?? []` fallback would otherwise mint a
  // fresh empty array on every render before the first fetch resolves,
  // churning every downstream callback / memo that depends on it.
  const pages = useMemo(() => inbox.data?.pages ?? EMPTY_INBOX_PAGES, [inbox.data?.pages]);
  const total = pages[0]?.total ?? 0;
  const inboxPageCount = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  // Clamp during render — when invalidation drops the total below the
  // parked index (e.g. user archived items from another client), the rail
  // shows the last valid page without a state write. Prev/next handlers
  // read off `safeInboxPage` so a stale index can't strand the user.
  const safeInboxPage = Math.min(inboxPageIndex, inboxPageCount - 1);
  const rawInboxItems = useMemo(
    () => pages[safeInboxPage]?.items ?? EMPTY_INBOX_ITEMS,
    [pages, safeInboxPage],
  );
  const inboxItems = useMemo(
    () => overlayTriageTags(rawInboxItems, tagsByThreadId),
    [rawInboxItems, tagsByThreadId],
  );

  const onPrevInbox = useCallback(() => {
    setInboxPageIndex(Math.max(0, safeInboxPage - 1));
  }, [safeInboxPage]);

  const fetchNextPage = inbox.fetchNextPage;
  const onNextInbox = useCallback(() => {
    const target = safeInboxPage + 1;
    if (target >= inboxPageCount) return;
    // If we haven't fetched this page yet, fire the request — the page
    // will land in cache and re-render with items populated. Don't gate
    // the index advance on the fetch; React Query renders the existing
    // (empty) page until the fetch resolves and InboxFeed surfaces the
    // spinner in the indicator.
    if (!pages[target]) void fetchNextPage();
    setInboxPageIndex(target);
  }, [safeInboxPage, inboxPageCount, pages, fetchNextPage]);

  const onOpenInbox = useCallback((documentId: string) => {
    setSelectedInboxId(documentId);
  }, []);
  const onCloseInbox = useCallback(() => setSelectedInboxId(null), []);

  // "Mark all read" is bulk by the page's visible-unread ids — InboxFeed
  // computes that set and hands it to us. `useMarkInboxRead` invalidates
  // ["me","inbox"] on success, so the rail rerenders with the rows
  // already showing as read.
  const markInboxRead = useMarkInboxRead();
  const markInboxReadMutate = markInboxRead.mutate;
  const onMarkInboxRead = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (ids.length === 0) return;
      markInboxReadMutate(ids);
    },
    [markInboxReadMutate],
  );
  const onOverrideTriageTag = useCallback(
    (threadId: string, category: TriageCategory) => {
      void overrideTag(threadId, category);
    },
    [overrideTag],
  );

  const meetingsData = meetings.data;
  const briefingData = briefing.data;
  const latestBriefing =
    briefingData?.status === "sent" || briefingData?.status === "suppressed" ? briefingData : null;
  return useMemo(
    () => ({
      ...EMPTY_RAIL_DATA,
      todos: todoItems,
      todoSuggestions,
      onToggleTodo,
      onClearTodo,
      onCreateTodo,
      onCompleteSuggestion,
      onPromoteSuggestion,
      onDismissSuggestion,
      inbox: inboxItems,
      inboxPagination: {
        pageIndex: safeInboxPage,
        pageCount: inboxPageCount,
        total,
        isLoading: inbox.isFetching,
        onPrev: onPrevInbox,
        onNext: onNextInbox,
      },
      selectedInboxId,
      onOpenInbox,
      onCloseInbox,
      onMarkInboxRead,
      markInboxReadPending: markInboxRead.isPending,
      triageTagsByThreadId: tagsByThreadId,
      onOverrideTriageTag,
      meetings: meetingsData?.items ?? [],
      calendarConnected: meetingsData?.connected ?? false,
      latestBriefing,
      onGenerateBriefing,
      briefingPending: composing || runBriefing.isPending,
    }),
    [
      todoItems,
      todoSuggestions,
      onToggleTodo,
      onClearTodo,
      onCreateTodo,
      onCompleteSuggestion,
      onPromoteSuggestion,
      onDismissSuggestion,
      inboxItems,
      safeInboxPage,
      inboxPageCount,
      total,
      inbox.isFetching,
      onPrevInbox,
      onNextInbox,
      selectedInboxId,
      onOpenInbox,
      onCloseInbox,
      onMarkInboxRead,
      markInboxRead.isPending,
      tagsByThreadId,
      onOverrideTriageTag,
      meetingsData,
      latestBriefing,
      onGenerateBriefing,
      composing,
      runBriefing.isPending,
    ],
  );
}

/** Demanding leads, muted sinks; preserves server order within a band (stable). */
const ATTENTION_BAND_ORDER: Record<AttentionBand, number> = { demanding: 0, normal: 1, muted: 2 };

/**
 * Overlay each thread's synced triage tag onto its inbox row and compute the
 * presentation-layer attention band (ADR-0064 / #210), then order by it.
 *
 * The band is derived — never stored on the row, never a re-tag: honest
 * category × sender significance (from the tag) × cross-row recurrence decay,
 * through the same `@alfred/contracts` scorer the briefing read path uses.
 * Recurrence is a property of the *visible set*, so it's computed over the
 * whole page at once. Rows are then stable-sorted so demanding items lead and
 * recurring machine noise / low-significance cold senders sink — the honest
 * category chip on each row is unchanged.
 */
function overlayTriageTags(
  items: ReadonlyArray<InboxItem>,
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>,
): ReadonlyArray<InboxItem> {
  if (items.length === 0) return items;

  // 1. Merge the synced tag's category/source onto each row.
  const merged = items.map((item) => {
    const tag = item.threadId ? tagsByThreadId.get(item.threadId) : undefined;
    if (!tag) return { item, significanceBand: null };
    const withTag =
      item.category === tag.category && item.categorySource === tag.source
        ? item
        : { ...item, category: tag.category, categorySource: tag.source };
    return { item: withTag, significanceBand: tag.senderSignificanceBand };
  });

  // 2. Score the whole visible page together so recurrence (cross-row) is real.
  //    Untriaged rows get no band (null) — never demoted on a guess.
  const scored = scoreAttentionForItems(
    merged.map(({ item, significanceBand }) => ({
      // The bare address (not the display name) is what reveals a bulk mailbox
      // and keys the recurrence grouping.
      sender: item.senderAddress ?? item.sender,
      subject: item.subject,
      category: item.category ?? "fyi",
      significanceBand,
      // Order recurrence chronologically — the rail is newest-first, so without
      // this the latest copy of a repeated alarm would (wrongly) stay demanding.
      occurredAtMs: item.authoredAtMs,
    })),
  );
  const withBand = merged.map(({ item }, i) => {
    const band: AttentionBand | null = item.category ? (scored[i]?.band ?? null) : null;
    return item.attentionBand === band ? item : { ...item, attentionBand: band };
  });

  // 3. Stable-sort by band (demanding → normal/untriaged → muted).
  return withBand
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rank =
        ATTENTION_BAND_ORDER[a.item.attentionBand ?? "normal"] -
        ATTENTION_BAND_ORDER[b.item.attentionBand ?? "normal"];
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Map a synced todo to the rail's display shape (ADR-0050). */
function toRailTodoItem(t: SyncedTodo): TodoItem {
  const provider = t.sources[0]?.provider;
  const source: TodoItem["source"] =
    provider === "gmail"
      ? "email"
      : provider === "calendar"
        ? "meeting"
        : t.createdBy === "user"
          ? "manual"
          : undefined;
  return {
    id: t.id,
    title: t.name,
    done: t.status === "done",
    source,
    due: t.dueDate ?? undefined,
  };
}

/** Map a `suggested` todo to the rail's suggestion shape; `assist` is the subtitle. */
function toRailSuggestion(t: SyncedTodo): SuggestionInput {
  return { id: t.id, label: t.name, detail: t.assist ?? "" };
}

const SUGGESTION_UNDO_MS = 5000;

/**
 * Deferred-commit dismissal for todo suggestions. Hiding is immediate (the id
 * joins `hiddenSuggestionIds`, which the caller filters out), but the terminal
 * `todoDismiss` mutation only fires after the undo window — so "Undo" cancels
 * the pending commit locally. (`dismissed` rows never sync back, so there is no
 * server-side row to restore once committed.) A still-pending dismissal is
 * committed on unmount so navigating away doesn't silently lose it.
 */
function useSuggestionDismissal(
  suggestions: ReadonlyArray<SyncedTodo>,
  dismissTodo: (id: string) => Promise<void>,
): {
  hiddenSuggestionIds: ReadonlySet<string>;
  onDismissSuggestion: (id: string) => void;
} {
  const [hiddenSuggestionIds, setHiddenSuggestionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>> | null>(null);
  if (timers.current === null) timers.current = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTimers = timers.current;

  useEffect(() => {
    const pending = pendingTimers;
    return () => {
      for (const [id, handle] of pending) {
        clearTimeout(handle);
        void dismissTodo(id);
      }
      pending.clear();
    };
  }, [pendingTimers, dismissTodo]);

  const cancel = useCallback(
    (id: string) => {
      const handle = pendingTimers.get(id);
      if (handle) clearTimeout(handle);
      pendingTimers.delete(id);
      setHiddenSuggestionIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [pendingTimers],
  );

  const onDismissSuggestion = useCallback(
    (id: string) => {
      if (pendingTimers.has(id)) return;
      const label = suggestions.find((s) => s.id === id)?.name;
      setHiddenSuggestionIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      const handle = setTimeout(() => {
        pendingTimers.delete(id);
        setHiddenSuggestionIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        void dismissTodo(id);
      }, SUGGESTION_UNDO_MS);
      pendingTimers.set(id, handle);
      toast.message({
        message: "Suggestion dismissed",
        description: label,
        duration: SUGGESTION_UNDO_MS,
        position: "bottom-right",
        action: { label: "Undo", onClick: () => cancel(id) },
      });
    },
    [suggestions, cancel, pendingTimers, dismissTodo],
  );

  return { hiddenSuggestionIds, onDismissSuggestion };
}

function formatDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const day = date.getDate();
  return `${weekday}, ${month} ${day}${ordinal(day)}`;
}

function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Mirrors what Tiptap's `editor.getText()` would produce for the given JSON,
 * used to seed the `canSend` check from a restored draft before the first
 * onUpdate fires. Each mention node contributes `@<label>` to match the
 * editor's configured `renderText`.
 */
function extractTextFromJSON(json: JSONContent): string {
  let out = "";
  const walk = (node: JSONContent) => {
    if (node.type === "text" && typeof node.text === "string") {
      out += node.text;
    } else if (node.type === "mention") {
      const label = node.attrs?.label ?? node.attrs?.id ?? "";
      out += `@${label}`;
    }
    if (Array.isArray(node.content)) {
      // ProseMirror block separators show up as newlines in getText().
      let first = true;
      for (const child of node.content) {
        if (!first && (child.type === "paragraph" || child.type === "hardBreak")) {
          out += "\n";
        }
        walk(child);
        first = false;
      }
    }
  };
  walk(json);
  return out;
}
