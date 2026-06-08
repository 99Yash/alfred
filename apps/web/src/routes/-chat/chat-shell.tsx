import type { TriageCategory } from "@alfred/contracts";
import type { SyncedTodo, SyncedTriageTag } from "@alfred/sync";
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
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { Particles } from "~/components/ui/particles";
import { AppPill } from "~/components/ui/v2";
import { useAppTheme } from "~/components/ui/v2/theme";
import { INBOX_PAGE_SIZE, useInbox, useMarkInboxRead, type InboxPage } from "~/hooks/use-inbox";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
import { useMeetings } from "~/hooks/use-meetings";
import { useRightRail, useSidebarState } from "~/lib/app-shell";
import { authClient } from "~/lib/auth-client";
import { stopChatRun, transcribeRecording } from "~/lib/chat/turn-controls";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { useRunComplete } from "~/lib/chat/use-run-complete";
import { useSendMessage } from "~/lib/chat/use-send-message";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { useResolvedIntegrations } from "~/hooks/use-integration-status";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { useChatMessages } from "~/lib/replicache/use-chat";
import { useTodos } from "~/lib/replicache/use-todos";
import { useTriageTags } from "~/lib/replicache/use-triage-tags";
import { safeGet, safeRemove, safeSet } from "~/lib/storage";
import { callToast } from "~/lib/toast";
import { firstName, greeting } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import type { InboxItem, TodoItem } from "~/routes/-preview-chat/helpers";
import { useRailMode } from "~/routes/-preview-chat/helpers";
import { IconButton } from "~/routes/-preview-chat/icon-button";
import { EMPTY_RAIL_DATA, type RailData } from "~/routes/-preview-chat/rail-content";
import { RightRail } from "~/routes/-preview-chat/right-rail";
import type { SuggestionInput } from "~/routes/-preview-chat/todo-feed";
import { ChatApprovalTray } from "./approval-tray";
import { buildFollowUpSuggestions, shouldShowStream } from "./conversation-helpers";
import { Conversation } from "./conversation";
import { filterMentionOptions, type MentionOption } from "./mention-options";
import { formatElapsed } from "./mic-recording-format";
import { MicWaveform, useMicRecording } from "./mic-recording";
import {
  TiptapComposer,
  type SuggestionRenderState,
  type TiptapComposerHandle,
} from "./tiptap-composer";

const MODEL_LEADING = <Sparkles size={12} />;

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
  useRightRail(railNode);

  const messages = useChatMessages(threadId);
  const stream = useChatStream(threadId);
  useRunComplete(stream);
  const send = useSendMessage();
  const onSend = useCallback((text: string) => void send(threadId, text), [send, threadId]);
  const showStream = shouldShowStream(messages, stream);
  const isStreaming = showStream && !stream.done;
  const activeRunId = showStream ? stream.runId : undefined;
  const awaitingApproval = Boolean(showStream && stream.awaitingApproval);
  const { rows: approvalRows } = useActionStagings();
  const runApprovals = useMemo(
    () => (activeRunId ? approvalRows.filter((row) => row.runId === activeRunId) : []),
    [approvalRows, activeRunId],
  );
  const approvalTrayActive = awaitingApproval || runApprovals.length > 0;
  const hasConversation = messages.length > 0 || showStream;

  // Follow-up suggestions for the last completed reply. The first one becomes
  // the composer's ghost text (Tab to accept); the rest render as chips in the
  // transcript — same content stream, two affordances, no duplication.
  const followUps = useMemo(
    () => (showStream ? [] : buildFollowUpSuggestions(messages)),
    [messages, showStream],
  );
  const chipFollowUps = useMemo(() => followUps.slice(1), [followUps]);
  const lastMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null;
  // Ghost dismissal is per-reply: accepting or Escaping hides it until the
  // next assistant message produces a fresh suggestion.
  const [ghostDismissedFor, setGhostDismissedFor] = useState<string | null>(null);
  const ghostSuggestion = followUps[0];
  const ghostText =
    ghostSuggestion && ghostDismissedFor !== lastMessageId ? ghostSuggestion.text : undefined;
  const onGhostDone = useCallback(() => setGhostDismissedFor(lastMessageId), [lastMessageId]);

  // Stop the in-flight turn (composer stop button). Best-effort: the worker
  // notices the Redis flag and finalizes the partial reply through the normal
  // `chat.message completed` flow, so no client-side reconciliation here.
  const onStopGeneration = useCallback(() => {
    if (!activeRunId) return;
    void stopChatRun(activeRunId).then((ok) => {
      if (!ok) callToast({ message: "Couldn't stop the reply. Please try again.", type: "danger" });
    });
  }, [activeRunId]);

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <TopBar title={title} railOpen={railOpen} onToggleRail={() => setRailOpen((v) => !v)} />
      {hasConversation ? (
        <>
          <Conversation
            messages={messages}
            stream={stream}
            onFollowUp={onSend}
            followUps={chipFollowUps}
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
                ghostText={ghostText}
                onGhostAccept={onGhostDone}
                onGhostDismiss={onGhostDone}
              />
            </div>
          </div>
        </>
      ) : (
        <EmptyHero threadId={threadId} isStreaming={isStreaming} onSend={onSend} />
      )}
    </div>
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
      <div className="flex items-center gap-2 min-w-0">
        {!sidebarOpen ? (
          <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={14} />
          </IconButton>
        ) : null}
        <h1 className="truncate text-sm font-medium text-app-fg-4">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5">
        <IconButton label="Share thread">
          <Share2 size={14} />
        </IconButton>
        <IconButton label="Thread settings">
          <Ellipsis size={14} />
        </IconButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-app-bg-3" />
        <IconButton
          label={railOpen ? "Hide today panel" : "Show today panel"}
          onClick={onToggleRail}
          active={railOpen}
        >
          <PanelRight size={14} />
        </IconButton>
      </div>
    </header>
  );
}

function EmptyHero({
  threadId,
  isStreaming,
  onSend,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  onSend?: (text: string) => void;
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
        <p className="text-[11px] uppercase tracking-tight font-medium text-app-fg-2">
          {formatDate(now)}
        </p>
        <h2 className="mt-3 text-3xl md:text-4xl font-medium tracking-[-0.04em] text-app-fg-4 text-center">
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
        "absolute bottom-full left-0 right-0 mb-2 z-20",
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
        className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-tight font-medium text-app-fg-2"
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
                "w-full flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left",
                "transition-colors",
                isActive ? "bg-app-bg-a2" : "hover:bg-app-bg-a2",
                "outline-none",
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-app-bg-2">
                {opt.brand ? (
                  <IntegrationGlyph brand={opt.brand} size={14} />
                ) : Icon ? (
                  <Icon size={13} className="text-app-fg-3" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-app-fg-4 truncate">
                  {opt.label}
                </span>
                <span className="block text-[11px] text-app-fg-2 truncate">{opt.subtitle}</span>
              </span>
              {isActive ? (
                <span className="text-[10px] text-app-fg-2 tabular-nums px-1.5 py-0.5 rounded bg-app-bg-2">
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
  // instead of a hardcoded brand list — the icons shown are exactly the
  // integrations Alfred supports, and each reflects whether *this* user has
  // actually connected it (with the required scopes). See
  // `useResolvedIntegrations`.
  const integrations = useResolvedIntegrations();

  // Unconnected first (these are the actual nudge), connected trailing with
  // a check. Catalog order is preserved within each group.
  const ordered = useMemo(() => {
    const unconnected = integrations.filter((p) => p.status !== "connected");
    const connected = integrations.filter((p) => p.status === "connected");
    return { unconnected, connected, all: [...unconnected, ...connected] };
  }, [integrations]);

  // Everything Alfred supports is already connected — there's nothing to
  // nudge, so drop the row entirely and keep the empty-chat hero clean.
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
            <span
              key={p.id}
              title={connected ? `${p.name} — connected` : p.name}
              className={cn(
                "relative grid size-[22px] shrink-0 place-items-center rounded-full",
                "bg-app-bg-2 ring-2 ring-app-background",
                i > 0 && "-ml-1.5",
                "transition-transform duration-200 ease-out hover:z-20 hover:scale-110",
                connected ? "z-10" : "",
              )}
            >
              <span className="sr-only">
                {connected ? `${p.name}, connected` : p.name}
              </span>
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
                    "absolute -bottom-0.5 -right-0.5 grid size-2.5 place-items-center",
                    "rounded-full bg-emerald-400 text-black",
                    "ring-2 ring-app-background",
                  )}
                >
                  <Check size={7} strokeWidth={3.5} />
                </span>
              ) : null}
            </span>
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
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  disabled?: boolean;
  onSend?: (text: string) => void;
  onStopGeneration?: () => void;
  /** Suggested next prompt shown dimmed in the empty editor; Tab accepts. */
  ghostText?: string;
  onGhostAccept?: () => void;
  onGhostDismiss?: () => void;
}) {
  const { resolved: theme } = useAppTheme();
  const editorRef = useRef<TiptapComposerHandle | null>(null);
  const { initialJSON, text, isEmpty, onEditorChange, resetDraft } = useComposerDraft(threadId);
  const voice = useComposerVoice(editorRef);
  const mention = useMentionController();
  const { mic, transcribing, voiceError, onVoiceStart, onVoiceConfirm } = voice;
  const { suggestion, mentionCandidates, visibleMentionIdx, suggestionKeyDownRef } = mention;
  const canSend = !disabled && !isEmpty && !mic.recording && !isStreaming && !transcribing;

  const insertAtTrigger = useCallback(() => {
    if (disabled) return;
    editorRef.current?.insertAtTrigger();
  }, [disabled]);

  useTypeAnywhere(editorRef, disabled);

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    const value = text.trim();
    onSend?.(value);
    editorRef.current?.clear();
    resetDraft();
  }, [canSend, text, onSend, resetDraft]);

  const onFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit();
  };

  return (
    <form
      onSubmit={onFormSubmit}
      aria-label="Send a message"
      data-disabled={disabled || undefined}
      className="relative"
    >
      {!disabled && suggestion && mentionCandidates.length > 0 ? (
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
          "app-elevated relative rounded-3xl p-2 overflow-hidden",
          // Transparent surface — particles + the app-elevated hairline carry
          // the composer's visual identity now, no solid fill needed.
          // Light mode gets a stronger inset ring on top of app-elevated's 0.05
          // hairline so the edge reads against the white page; dark relies on
          // app-elevated's existing inset white ring.
          theme === "light" && "ring-1 ring-inset ring-app-fg-a1/50",
          "focus-within:ring-2 focus-within:ring-app-purple-2 focus-within:ring-offset-4",
          "focus-within:ring-offset-app-background transition-shadow",
          disabled && "opacity-70",
        )}
      >
        {/* Ambient drifting particles inside the composer surface. Sits
         * underneath the editor + controls via stacking order (rendered first
         * + pointer-events-none from the component). Re-keyed on theme so the
         * canvas re-mounts with the right color. Stardust away while the
         * user has text in the editor — mirrors the placeholder exit. */}
        <Particles
          key={theme}
          className="absolute inset-0"
          quantity={20}
          color={theme === "dark" ? "#ffffff" : "#000000"}
          maxAlpha={theme === "dark" ? 0.3 : 0.45}
          dispersed={!isEmpty}
        />
        {/* Wrap editor + controls in a positioned container so they paint
         * above the absolutely-positioned particles canvas (positioned
         * siblings with z-auto paint in tree order). */}
        <div className="relative">
          {/* Keep the editor mounted (just hidden) while recording so its
           * content survives the voice round-trip — the transcript appends to
           * whatever was already typed instead of a remount reverting to the
           * mount-time draft. */}
          <div className={cn(mic.recording && "hidden")}>
            <TiptapComposer
              ref={editorRef}
              initialJSON={initialJSON}
              placeholder="Type and press enter to start chatting…"
              disabled={disabled}
              onChange={onEditorChange}
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
            disabled={disabled}
            mentionActive={suggestion !== null}
            onMentionClick={insertAtTrigger}
            transcribing={transcribing}
            voiceError={voiceError}
            onVoiceStart={onVoiceStart}
            onVoiceConfirm={() => void onVoiceConfirm()}
            onStopGeneration={onStopGeneration}
          />
        </div>
      </div>
    </form>
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
    if (parsed && typeof parsed === "object" && "type" in parsed) return parsed;
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
  mentionActive,
  onMentionClick,
  transcribing,
  voiceError,
  onVoiceStart,
  onVoiceConfirm,
  onStopGeneration,
}: {
  mic: ReturnType<typeof useMicRecording>;
  canSend: boolean;
  isStreaming: boolean;
  disabled: boolean;
  mentionActive: boolean;
  onMentionClick: () => void;
  transcribing: boolean;
  voiceError: string | null;
  onVoiceStart: () => void;
  onVoiceConfirm: () => void;
  onStopGeneration?: () => void;
}) {
  const statusMessage = voiceError ?? mic.error;
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
      <div className="flex items-center gap-1">
        <ComposerIcon label="Attach file" disabled={disabled || mic.recording}>
          <Paperclip size={14} />
        </ComposerIcon>
        <ComposerIcon
          label="Mention a source"
          disabled={disabled || mic.recording}
          onClick={onMentionClick}
          active={!disabled && mentionActive}
        >
          <AtSign size={14} />
        </ComposerIcon>
        <AppPill
          className="h-7 px-2 text-[12px] text-app-fg-3"
          leading={MODEL_LEADING}
          chevron
          disabled
          title="Model picker — coming with m13"
        >
          Auto
        </AppPill>
        {transcribing ? (
          <span className="animate-chat-shimmer text-[11px] text-app-fg-3 pl-1">Transcribing…</span>
        ) : statusMessage ? (
          <span className="text-[11px] text-app-red-4 pl-1">{statusMessage}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {mic.recording ? (
          <>
            {/* Voice mode: X discards the take, ✓ sends it to transcription. */}
            <ComposerIcon label="Discard recording" onClick={mic.cancel}>
              <X size={14} />
            </ComposerIcon>
            <button
              type="button"
              onClick={onVoiceConfirm}
              aria-label="Use recording"
              className={cn(
                "size-9 shrink-0 inline-flex items-center justify-center rounded-full",
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
          </>
        ) : (
          <>
            <ComposerIcon
              label="Dictate"
              onClick={onVoiceStart}
              disabled={disabled || transcribing}
            >
              {transcribing ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
            </ComposerIcon>
            {isStreaming && onStopGeneration ? (
              <button
                type="button"
                onClick={onStopGeneration}
                aria-label="Stop generating"
                className={cn(
                  "size-9 shrink-0 inline-flex items-center justify-center rounded-full",
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
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label={
                  disabled ? "Waiting for approval" : isStreaming ? "Waiting for response" : "Send"
                }
                className={cn(
                  "size-9 shrink-0 inline-flex items-center justify-center rounded-full",
                  "app-press transition-[opacity,filter,transform]",
                  "enabled:hover:scale-[1.04] active:scale-[0.97]",
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
                    : "bg-app-bg-2 text-app-fg-2 cursor-not-allowed",
                )}
              >
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
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
    <div className="relative h-[64px] px-3 pt-2 pb-1.5 flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-tight font-medium text-app-fg-3 shrink-0">
        <span aria-hidden className="chat-rec-dot size-1.5 rounded-full bg-app-red-4" />
        <span className="tabular-nums text-app-fg-4">{formatElapsed(elapsed)}</span>
        <span className="text-app-fg-2">Listening</span>
      </span>
      <div className="flex-1 h-12">
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
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={onClick ? Boolean(active) : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "size-8 inline-flex items-center justify-center rounded-full",
        "transition-colors app-press",
        active
          ? "bg-app-purple-1 text-app-purple-4"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-app-fg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {children}
    </button>
  );
}

/* ----------- helpers ----------- */

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
  const briefing = useLatestBriefing();

  // Live todos + Alfred's suggestions (ADR-0050), Replicache-synced.
  const {
    todos: liveTodos,
    suggestions: liveSuggestions,
    createTodo,
    completeTodo,
    reopenTodo,
    promoteTodo,
    dismissTodo,
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
  const onCreateTodo = useCallback((title: string) => void createTodo(title), [createTodo]);
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
  return useMemo(
    () => ({
      ...EMPTY_RAIL_DATA,
      todos: todoItems,
      todoSuggestions,
      onToggleTodo,
      onCreateTodo,
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
      latestBriefing: briefingData ?? null,
    }),
    [
      todoItems,
      todoSuggestions,
      onToggleTodo,
      onCreateTodo,
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
      briefingData,
    ],
  );
}

function overlayTriageTags(
  items: ReadonlyArray<InboxItem>,
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>,
): ReadonlyArray<InboxItem> {
  if (tagsByThreadId.size === 0) return items;
  let changed = false;
  const next = items.map((item) => {
    const tag = item.threadId ? tagsByThreadId.get(item.threadId) : undefined;
    if (!tag) return item;
    if (item.category === tag.category && item.categorySource === tag.source) return item;
    changed = true;
    return { ...item, category: tag.category, categorySource: tag.source };
  });
  return changed ? next : items;
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
      callToast({
        message: "Suggestion dismissed",
        description: label,
        duration: SUGGESTION_UNDO_MS,
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
