import { Link } from "@tanstack/react-router";
import type { JSONContent } from "@tiptap/react";
import {
  ArrowUp,
  AtSign,
  Ellipsis,
  Mic,
  PanelLeft,
  PanelRight,
  Paperclip,
  Share2,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Particles } from "~/components/ui/particles";
import { VsPill } from "~/components/ui/visitors";
import { useVsTheme } from "~/components/ui/visitors/theme";
import { useInbox, INBOX_PAGE_SIZE, type InboxPage } from "~/hooks/use-inbox";
import type { InboxItem } from "~/routes/-preview-chat/helpers";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
import { useMeetings } from "~/hooks/use-meetings";
import { useRightRail, useSidebarState } from "~/lib/app-shell";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { IconButton } from "~/routes/-preview-chat/icon-button";
import { useRailMode } from "~/routes/-preview-chat/helpers";
import { EMPTY_RAIL_DATA, type RailData } from "~/routes/-preview-chat/rail-content";
import { RightRail } from "~/routes/-preview-chat/right-rail";
import { filterMentionOptions, type MentionOption } from "./mention-options";
import {
  TiptapComposer,
  type SuggestionRenderState,
  type TiptapComposerHandle,
} from "./tiptap-composer";
import { formatElapsed, MicWaveform, useMicRecording } from "./mic-recording";

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

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <TopBar
        title={title}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
      />
      <EmptyHero threadId={threadId} />
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
        "vs-frost-header sticky top-0 z-10",
        "flex h-14 shrink-0 items-center justify-between gap-3 px-5",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {!sidebarOpen ? (
          <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={14} />
          </IconButton>
        ) : null}
        <h1 className="truncate text-sm font-medium text-vs-fg-4">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5">
        <IconButton label="Share thread">
          <Share2 size={14} />
        </IconButton>
        <IconButton label="Thread settings">
          <Ellipsis size={14} />
        </IconButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-vs-bg-3" />
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

function EmptyHero({ threadId }: { threadId: string | undefined }) {
  const { data: session } = authClient.useSession();
  const name = firstName(session?.user);
  const now = new Date();

  // Cluster greeting + composer + connect-tools as a single block centered
  // in the remaining viewport. flex-col + justify-center keeps the group
  // tight whether the column is 600px or 1000px tall.
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center">
        <p className="text-[11px] uppercase tracking-tight font-medium text-vs-fg-2">
          {formatDate(now)}
        </p>
        <h2 className="mt-3 text-3xl md:text-4xl font-medium tracking-[-0.04em] text-vs-fg-4 text-center">
          {greeting(now)}
          {name ? <span className="text-vs-fg-3">, {name}</span> : null}
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
        <Composer key={threadId ?? "new"} threadId={threadId} />
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
        "vs-elevated rounded-2xl bg-vs-bg-1 p-1.5",
        "max-h-72 overflow-y-auto",
        // Subtle entry — slide up + fade. Tailwind's `animate-in` keyframes
        // ship with the project (used elsewhere as `vs-card-in`); fall back
        // to a plain fade so it never appears static.
        "transition-opacity duration-150 ease-out",
      )}
    >
      <p
        id={labelId}
        className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-tight font-medium text-vs-fg-2"
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
                isActive ? "bg-vs-bg-a2" : "hover:bg-vs-bg-a2",
                "outline-none",
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-vs-bg-2">
                {opt.brand ? (
                  <IntegrationGlyph brand={opt.brand} size={14} />
                ) : Icon ? (
                  <Icon size={13} className="text-vs-fg-3" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-vs-fg-4 truncate">
                  {opt.label}
                </span>
                <span className="block text-[11px] text-vs-fg-2 truncate">
                  {opt.subtitle}
                </span>
              </span>
              {isActive ? (
                <span className="text-[10px] text-vs-fg-2 tabular-nums px-1.5 py-0.5 rounded bg-vs-bg-2">
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
        "focus-visible:ring-2 focus-visible:ring-vs-purple-2",
        "focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
    >
      <span
        className={cn(
          "text-[13px] font-medium text-vs-fg-2",
          "transition-colors duration-200 group-hover:text-vs-fg-4",
        )}
      >
        Connect your tools
      </span>

      <div className="ml-auto flex items-center gap-2">
        {CONNECT_BRANDS.map(({ brand, label }) => (
          <span
            key={brand}
            title={label}
            className={cn(
              "relative grid size-5 shrink-0 place-items-center",
              // Resting: slightly muted so the row reads as a soft hint,
              // not a busy color block. Brightens on group hover.
              "opacity-70 transition-[opacity,transform] duration-200 ease-out",
              "group-hover:opacity-100 hover:scale-[1.12]",
            )}
          >
            <span className="sr-only">{label}</span>
            <IntegrationGlyph brand={brand} size={16} />
          </span>
        ))}
      </div>
    </Link>
  );
}

const CONNECT_BRANDS: ReadonlyArray<{ brand: IntegrationBrand; label: string }> = [
  { brand: "gmail", label: "Gmail" },
  { brand: "google_calendar", label: "Calendar" },
  { brand: "google_drive", label: "Drive" },
  { brand: "slack", label: "Slack" },
  { brand: "github", label: "GitHub" },
  { brand: "linear", label: "Linear" },
  { brand: "web", label: "Web search" },
];

function Composer({ threadId }: { threadId: string | undefined }) {
  const { resolved: theme } = useVsTheme();

  // Persist drafts per thread (and a shared "new chat" bucket for the empty
  // /chat hero). Survives refresh; cleared on submit.
  const draftKey = `alfred:chat-draft:${threadId ?? "new"}`;

  // Seed the editor once on mount. Stored drafts are Tiptap JSON; we also
  // accept the legacy plain-string format so drafts written by the previous
  // textarea+mirror composer survive the migration.
  const initialJSON = useMemo<JSONContent | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(draftKey);
    } catch {
      return undefined;
    }
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
  }, [draftKey]);

  const editorRef = useRef<TiptapComposerHandle | null>(null);
  const mic = useMicRecording();

  const [text, setText] = useState<string>(() => {
    // Mirror what Tiptap will report on mount so the send button reflects
    // restored drafts before the first onChange fires.
    if (!initialJSON) return "";
    return extractTextFromJSON(initialJSON);
  });
  const [isEmpty, setIsEmpty] = useState<boolean>(() => text.trim().length === 0);
  const canSend = !isEmpty && !mic.recording;

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
  // without an effect that loops state back through React. The keyboard
  // handler reads off `visibleMentionIdx` so a stale `mentionIdx` can't
  // walk past the new list bounds either.
  const visibleMentionIdx =
    mentionCandidates.length === 0
      ? 0
      : Math.min(mentionIdx, mentionCandidates.length - 1);

  const insertMention = useCallback((option: MentionOption) => {
    suggestion?.command(option);
  }, [suggestion]);

  const insertAtTrigger = useCallback(() => {
    editorRef.current?.insertAtTrigger();
  }, []);

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

  // Persist drafts as JSON. Tiptap's onChange already fires after every doc
  // mutation, so this effect only needs to react to changes in `text` (used
  // as a coarse "did the editor mutate" signal — JSON identity would churn).
  const onEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      setText(nextText);
      setIsEmpty(nextEmpty);
      try {
        if (nextEmpty) {
          window.localStorage.removeItem(draftKey);
        } else {
          window.localStorage.setItem(draftKey, JSON.stringify(nextJSON));
        }
      } catch {
        // Quota / private-mode — drafts are best-effort, swallow.
      }
    },
    [draftKey],
  );

  // Type-anywhere autofocus: any printable keystroke on the page lands in
  // the composer. Skipped when the user is already inside an input / when a
  // modifier (⌘ / Ctrl / Alt) is held so app shortcuts still fire.
  useEffect(() => {
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
  }, []);

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    // Stub — wired in m13. Logging on dev so the input round-trips visibly.
    // eslint-disable-next-line no-console
    console.info("[chat] composer submit:", { threadId, value: text.trim() });
    editorRef.current?.clear();
    setText("");
    setIsEmpty(true);
    try {
      window.localStorage.removeItem(draftKey);
    } catch {
      // best-effort
    }
  }, [canSend, draftKey, text, threadId]);

  const onFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit();
  };

  return (
    <form onSubmit={onFormSubmit} aria-label="Send a message" className="relative">
      {suggestion && mentionCandidates.length > 0 ? (
        <MentionPalette
          options={mentionCandidates}
          activeIdx={visibleMentionIdx}
          onHover={setMentionIdx}
          onPick={insertMention}
          onClose={() => suggestion.dismiss()}
        />
      ) : null}
      <div
        className={cn(
          "vs-elevated relative rounded-3xl p-2 overflow-hidden",
          // Transparent surface — particles + the vs-elevated hairline carry
          // the composer's visual identity now, no solid fill needed.
          // Light mode gets a stronger inset ring on top of vs-elevated's 0.05
          // hairline so the edge reads against the white page; dark relies on
          // vs-elevated's existing inset white ring.
          theme === "light" && "ring-1 ring-inset ring-vs-fg-a1/50",
          "focus-within:ring-2 focus-within:ring-vs-purple-2 focus-within:ring-offset-4",
          "focus-within:ring-offset-vs-background transition-shadow",
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
        {mic.recording ? (
          <RecordingPanel
            levelsRef={mic.levelsRef}
            elapsed={mic.elapsed}
            active={mic.recording}
          />
        ) : (
          <TiptapComposer
            ref={editorRef}
            initialJSON={initialJSON}
            placeholder="Type and press enter to start chatting…"
            onChange={onEditorChange}
            onSubmit={handleSubmit}
            onSuggestionChange={setSuggestion}
            suggestionKeyDownRef={suggestionKeyDownRef}
          />
        )}

        <ComposerToolbar
          mic={mic}
          canSend={canSend}
          mentionActive={suggestion !== null}
          onMentionClick={insertAtTrigger}
        />
        </div>
      </div>
    </form>
  );
}

function ComposerToolbar({
  mic,
  canSend,
  mentionActive,
  onMentionClick,
}: {
  mic: ReturnType<typeof useMicRecording>;
  canSend: boolean;
  mentionActive: boolean;
  onMentionClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
      <div className="flex items-center gap-1">
        <ComposerIcon label="Attach file" disabled={mic.recording}>
          <Paperclip size={14} />
        </ComposerIcon>
        <ComposerIcon
          label="Mention a source"
          disabled={mic.recording}
          onClick={onMentionClick}
          active={mentionActive}
        >
          <AtSign size={14} />
        </ComposerIcon>
        <VsPill
          className="h-7 px-2 text-[12px] text-vs-fg-3"
          leading={MODEL_LEADING}
          chevron
          disabled
          title="Model picker — coming with m13"
        >
          Auto
        </VsPill>
        {mic.error ? (
          <span className="text-[11px] text-vs-red-4 pl-1">{mic.error}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <ComposerIcon
          label={mic.recording ? "Stop dictation" : "Dictate"}
          onClick={mic.recording ? mic.stop : mic.start}
          active={mic.recording}
        >
          <Mic size={14} />
        </ComposerIcon>
        {mic.recording ? (
          <button
            type="button"
            onClick={mic.stop}
            aria-label="Stop recording"
            className={cn(
              "size-9 shrink-0 inline-flex items-center justify-center rounded-full",
              "vs-press transition-[opacity,filter,transform]",
              "bg-vs-red-4 text-white",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_rgba(255,47,0,0.32)]",
              "hover:brightness-[1.05]",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
              "focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
            )}
          >
            <Square size={12} strokeWidth={2.5} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            className={cn(
              "size-9 shrink-0 inline-flex items-center justify-center rounded-full",
              "vs-press transition-[opacity,filter,transform]",
              "enabled:hover:scale-[1.04] active:scale-[0.97]",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
              "focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
              canSend
                ? cn(
                    "text-[var(--vs-accent-fg)]",
                    "bg-[image:var(--vs-cta-bg)]",
                    "shadow-[var(--vs-button-primary-shadow)]",
                    "hover:brightness-[1.06]",
                    "hover:shadow-[var(--vs-button-primary-shadow-hover)]",
                  )
                : "bg-vs-bg-2 text-vs-fg-2 cursor-not-allowed",
            )}
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
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
  levelsRef: React.RefObject<Float32Array>;
  elapsed: number;
  active: boolean;
}) {
  return (
    <div className="relative h-[64px] px-3 pt-2 pb-1.5 flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-tight font-medium text-vs-fg-3 shrink-0">
        <span aria-hidden className="chat-rec-dot size-1.5 rounded-full bg-vs-red-4" />
        <span className="tabular-nums text-vs-fg-4">{formatElapsed(elapsed)}</span>
        <span className="text-vs-fg-2">Listening</span>
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
        "transition-colors vs-press",
        active
          ? "bg-vs-purple-1 text-vs-purple-4"
          : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-vs-fg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
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

  // Local page index walks the cached `inbox.data.pages[]`. When the user
  // advances past the last loaded page we kick off `fetchNextPage`; back
  // navigation is free because the pages stay in cache.
  const [inboxPageIndex, setInboxPageIndex] = useState(0);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);

  // Stabilize array references — react-query keeps `data.pages` stable via
  // structural sharing, but the `?? []` fallback would otherwise mint a
  // fresh empty array on every render before the first fetch resolves,
  // churning every downstream callback / memo that depends on it.
  const pages = useMemo(
    () => inbox.data?.pages ?? EMPTY_INBOX_PAGES,
    [inbox.data?.pages],
  );
  const total = pages[0]?.total ?? 0;
  const inboxPageCount = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  // Clamp during render — when invalidation drops the total below the
  // parked index (e.g. user archived items from another client), the rail
  // shows the last valid page without a state write. Prev/next handlers
  // read off `safeInboxPage` so a stale index can't strand the user.
  const safeInboxPage = Math.min(inboxPageIndex, inboxPageCount - 1);
  const inboxItems = useMemo(
    () => pages[safeInboxPage]?.items ?? EMPTY_INBOX_ITEMS,
    [pages, safeInboxPage],
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

  const meetingsData = meetings.data;
  const briefingData = briefing.data;
  return useMemo(
    () => ({
      ...EMPTY_RAIL_DATA,
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
      meetings: meetingsData?.items ?? [],
      calendarConnected: meetingsData?.connected ?? false,
      latestBriefing: briefingData ?? null,
    }),
    [
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
      meetingsData,
      briefingData,
    ],
  );
}

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function firstName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) {
    const first = user.name.trim().split(/\s+/)[0] ?? "";
    return titleCase(first);
  }
  if (user.email) {
    const handle = user.email.split("@")[0] ?? "";
    return titleCase(handle);
  }
  return "";
}

function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function greeting(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
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
