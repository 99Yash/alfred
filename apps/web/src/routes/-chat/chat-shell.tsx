import { Link } from "@tanstack/react-router";
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { VsPill } from "~/components/ui/visitors";
import { useInbox } from "~/hooks/use-inbox";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
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
    <div className="relative flex min-w-0 flex-1 flex-col">
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

  // 3-row grid so the composer sits at the true vertical center of the
  // remaining viewport, with greeting floating above and connect-tools
  // floating below. The 1fr rows soak up unequal slack symmetrically.
  return (
    <div className="grid flex-1 grid-rows-[1fr_auto_1fr] px-6">
      <div className="self-end flex flex-col items-center pb-8">
        <p className="text-[11px] uppercase tracking-tight font-medium text-vs-fg-2">
          {formatDate(now)}
        </p>
        <h2 className="mt-3 text-3xl md:text-4xl font-medium tracking-tight text-vs-fg-4 text-center">
          {greeting(now)}
          {name ? <span className="text-vs-fg-3">, {name}</span> : null}
        </h2>
      </div>

      <div className="w-full max-w-2xl mx-auto">
        <Composer threadId={threadId} />
      </div>

      <div className="self-start pt-10">
        <ConnectToolsRow />
      </div>
    </div>
  );
}

function ConnectToolsRow() {
  return (
    <div className="mt-10 flex flex-col items-center gap-3">
      <p className="text-[11px] uppercase tracking-tight font-medium text-vs-fg-2">
        Connect your tools
      </p>
      <Link
        to="/integrations"
        aria-label="Connect your tools"
        className={cn(
          "inline-flex items-center gap-2 rounded-2xl p-1.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        {CONNECT_BRANDS.map((brand) => (
          <span
            key={brand}
            aria-hidden
            className={cn(
              "size-9 grid place-items-center rounded-xl",
              "bg-vs-bg-2 hover:bg-vs-bg-a2 transition-colors vs-press",
            )}
          >
            <IntegrationGlyph brand={brand} size={18} />
          </span>
        ))}
      </Link>
    </div>
  );
}

const CONNECT_BRANDS: IntegrationBrand[] = [
  "gmail",
  "google_calendar",
  "google_drive",
  "slack",
  "github",
  "linear",
  "web",
];

function Composer({ threadId }: { threadId: string | undefined }) {
  const [value, setValue] = useState("");
  const mic = useMicRecording();
  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !mic.recording;

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
          "vs-elevated relative rounded-3xl bg-vs-bg-1 p-2",
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
            value={value}
            onChange={setValue}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
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
                  "size-9 shrink-0 inline-flex items-center justify-center rounded-xl",
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
                  "size-9 shrink-0 inline-flex items-center justify-center rounded-xl",
                  "vs-press transition-[opacity,filter,transform]",
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
        "size-8 inline-flex items-center justify-center rounded-lg",
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
 * - Latest briefing → `/api/me/briefings/latest` (drives the footer
 *   CTA's subtitle).
 *
 * Todos + meetings stay empty — there's no schema yet — which surfaces
 * the honest "connect / add one" empty states in `TodoFeed` and
 * `MeetingsFeed`.
 */
function useRailData(): RailData {
  const inbox = useInbox();
  const briefing = useLatestBriefing();
  const inboxData = inbox.data;
  const briefingData = briefing.data;
  return useMemo(
    () => ({
      ...EMPTY_RAIL_DATA,
      inbox: inboxData ?? [],
      latestBriefing: briefingData ?? null,
    }),
    [inboxData, briefingData],
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
