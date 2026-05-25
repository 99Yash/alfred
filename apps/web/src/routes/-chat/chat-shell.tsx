import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
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
import { VsPill } from "~/components/ui/visitors";
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
import { TextareaWithMirror } from "./composer-text";
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
        <Composer threadId={threadId} />
        <ConnectToolsBar />
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
        // `group` for the trailing-arrow reveal. Same fill as the composer
        // above (`bg-vs-bg-1`) so the two sit as ONE card visually — only
        // the hairline `border-t` separates the input region from the
        // tools shelf. No second elevation, no tonal step-down.
        "group relative flex items-center gap-3 px-4 py-3",
        "rounded-b-3xl rounded-t-none",
        "bg-vs-bg-1 border-t border-vs-bg-3",
        // Subtle highlight on the divider on hover so the affordance reads
        // without ever feeling heavy.
        "transition-colors duration-200 ease-out",
        "hover:bg-vs-bg-a2",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
        "focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
    >
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "grid size-5 place-items-center rounded-md",
            "bg-vs-purple-1 text-vs-purple-4",
            "transition-transform duration-200 ease-out group-hover:rotate-[8deg]",
          )}
        >
          <Sparkles size={11} />
        </span>
        <span className="text-[13px] font-medium text-vs-fg-4">
          Connect your tools
        </span>
      </span>

      <div className="ml-auto flex items-center">
        <div className="flex items-center gap-2">
          {CONNECT_BRANDS.map(({ brand, label }) => (
            <span
              key={brand}
              title={label}
              className={cn(
                "relative grid size-5 shrink-0 place-items-center",
                "transition-transform duration-200 ease-out",
                "group-hover:scale-[1.08]",
              )}
            >
              <span className="sr-only">{label}</span>
              <IntegrationGlyph brand={brand} size={18} />
            </span>
          ))}
        </div>

        {/* Arrow reveals on hover/focus via a width animation so the bar
         * doesn't reflow at rest. */}
        <span
          aria-hidden
          className={cn(
            "inline-flex items-center overflow-hidden text-vs-fg-4",
            "max-w-0 opacity-0 -translate-x-1",
            "transition-[max-width,opacity,transform] duration-200 ease-out",
            "group-hover:max-w-5 group-hover:opacity-100 group-hover:translate-x-0 group-hover:pl-2",
            "group-focus-visible:max-w-5 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:pl-2",
          )}
        >
          <ArrowRight size={13} strokeWidth={2.25} />
        </span>
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
  // Persist drafts per thread (and a shared "new chat" bucket for the empty
  // /chat hero). Survives refresh; cleared on submit.
  const draftKey = `alfred:chat-draft:${threadId ?? "new"}`;
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      if (value) window.localStorage.setItem(draftKey, value);
      else window.localStorage.removeItem(draftKey);
    } catch {
      // Quota / private-mode — drafts are best-effort, swallow.
    }
  }, [value, draftKey]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useMicRecording();
  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !mic.recording;

  // Type-anywhere autofocus: any printable keystroke on the page lands in
  // the composer. Skipped when the user is already inside an input / when a
  // modifier (⌘ / Ctrl / Alt) is held so app shortcuts still fire.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.key || e.key.length !== 1) return; // ignore F-keys, arrows, etc.
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const ta = textareaRef.current;
      if (!ta || ta === document.activeElement) return;
      ta.focus();
      // Native event already consumed by the document; manually append so
      // the keystroke isn't lost between focus + browser default routing.
      e.preventDefault();
      const next = value + e.key;
      setValue(next);
      // Restore caret to end after React commits.
      queueMicrotask(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = next.length;
          textareaRef.current.selectionEnd = next.length;
        }
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [value]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSend) return;
    // Stub — wired in m13. Logging on dev so the input round-trips visibly.
    // eslint-disable-next-line no-console
    console.info("[chat] composer submit:", { threadId, value: trimmed });
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Send a message">
      <div
        className={cn(
          // Flat bottom so the `ConnectToolsBar` shelf tucks underneath as a
          // continuation, not a separate card.
          "vs-elevated relative rounded-3xl rounded-b-none p-2",
          // `bg-vs-bg-1` paints the solid fill; the radial gradient layers on
          // top via `background-image` as a subtle top-left gleam — adds
          // depth on dark, near-invisible on light. Stacks below children
          // automatically, no z-index gymnastics.
          "bg-vs-bg-1",
          "bg-[image:radial-gradient(circle_at_18%_0%,rgba(255,255,255,0.08)_0%,transparent_55%)]",
          "focus-within:ring-2 focus-within:ring-vs-purple-2 focus-within:ring-offset-4",
          "focus-within:ring-offset-vs-background transition-shadow",
        )}
      >
        {mic.recording ? (
          <RecordingPanel
            levelsRef={mic.levelsRef}
            elapsed={mic.elapsed}
            active={mic.recording}
          />
        ) : (
          <TextareaWithMirror
            textareaRef={textareaRef}
            value={value}
            onChange={setValue}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
                return;
              }
              if (e.key === "Escape") {
                // Esc blurs the composer so global shortcuts (⌘K, etc.)
                // route correctly without a wrestling match for focus.
                e.currentTarget.blur();
              }
            }}
            placeholder="Type and press enter to start chatting…"
          />
        )}

        <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
          <div className="flex items-center gap-1">
            <ComposerIcon label="Attach file" disabled={mic.recording}>
              <Paperclip size={14} />
            </ComposerIcon>
            <ComposerIcon label="Mention a source" disabled={mic.recording}>
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
      </div>
    </form>
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
