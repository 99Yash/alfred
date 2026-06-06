import { ListChecks, X } from "lucide-react";
import type { ReactNode } from "react";
import type { TriageCategory } from "@alfred/contracts";
import type { SyncedTriageTag } from "@alfred/sync";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { AppSegmented } from "~/components/ui/v2";
import { useWeather } from "~/hooks/use-weather";
import { authClient } from "~/lib/auth-client";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { firstName, greeting } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import type { InboxItem, MeetingItem, RailTab, TodoItem } from "./helpers";
import { InboxFeed } from "./inbox-feed";
import { MeetingsFeed, type MeetingLookaheadItem } from "./meetings-feed";
import { RailFooter } from "./rail-footer";
import { RailSlot } from "./rail-slot";
import { TodoFeed, type SuggestionInput } from "./todo-feed";
import { WeatherLine } from "./weather-line";

const RAIL_TABS: ReadonlyArray<{ value: RailTab; label: string; icon: ReactNode }> = [
  { value: "todo", label: "To do", icon: <ListChecks size={12} /> },
  // Inbox + Up next are both source-backed (Gmail / Google Calendar). Their
  // tab glyphs mirror the brand icons in `ConnectToolsRow` so a glance
  // tells the user which integration the tab is reading from.
  { value: "inbox", label: "Inbox", icon: <IntegrationGlyph brand="gmail" size={12} /> },
  {
    value: "meetings",
    label: "Up next",
    icon: <IntegrationGlyph brand="google_calendar" size={12} />,
  },
];

export interface RailBriefingSummary {
  /** Composed-briefing row id; reserved for a future "view briefing" surface. */
  id: string;
  /** e.g. `"morning"` / `"evening"`. */
  slot: string;
  /** Local-date the briefing covers (YYYY-MM-DD). */
  briefingDate: string;
  /** ISO timestamp when the briefing was composed. */
  runAt: string;
  subject: string | null;
}

/**
 * Server-driven pagination for the rail Inbox tab. When present, `InboxFeed`
 * surfaces ← → controls and the chat shell owns the page index; when absent
 * (preview route, fixtures), the feed renders without pagination.
 */
export interface InboxPagination {
  pageIndex: number;
  pageCount: number;
  total: number;
  isLoading: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export interface RailData {
  todos: ReadonlyArray<TodoItem>;
  todoSuggestions?: ReadonlyArray<SuggestionInput>;
  /** Check/uncheck a todo (ADR-0050). `done` is the row's current state. */
  onToggleTodo?: (id: string, done: boolean) => void;
  /** Add a user-authored todo from the rail's add row. */
  onCreateTodo?: (title: string) => void;
  /** Accept a suggestion (`suggested → open`). */
  onPromoteSuggestion?: (id: string) => void;
  inbox: ReadonlyArray<InboxItem>;
  /** Optional pagination state for the inbox tab. */
  inboxPagination?: InboxPagination;
  /** Document id of the email currently expanded in the rail reader, if any. */
  selectedInboxId?: string | null;
  /** Open the rail's single-email reader for `documentId`. */
  onOpenInbox?: (documentId: string) => void;
  /** Close the rail's single-email reader and return to the list view. */
  onCloseInbox?: () => void;
  /**
   * Bulk "Mark all read" handler. The InboxFeed calls it with the
   * currently-visible *unread* ids; the parent chat shell wires this
   * to `useMarkInboxRead()`. Optional — the preview route omits it, in
   * which case the button is a no-op (and we hide it).
   */
  onMarkInboxRead?: (documentIds: ReadonlyArray<string>) => void;
  /** True while a mark-read mutation is in flight — disables the button. */
  markInboxReadPending?: boolean;
  /** Synced tag rows keyed by Gmail thread id; overlays optimistic overrides. */
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag>;
  /** Pin a thread to a user-chosen triage category. */
  onOverrideTriageTag?: (threadId: string, category: TriageCategory) => void;
  meetings: ReadonlyArray<MeetingItem>;
  meetingLookahead?: ReadonlyArray<MeetingLookaheadItem>;
  /**
   * Whether the user has actually connected Google Calendar. Lets the
   * meetings empty state distinguish "connect Calendar" from "Calendar
   * connected, day is clear" — both render zero items.
   */
  calendarConnected?: boolean;
  /** Latest composed briefing for the user, or null if none has run yet. */
  latestBriefing?: RailBriefingSummary | null;
}

export const EMPTY_RAIL_DATA: RailData = {
  todos: [],
  inbox: [],
  meetings: [],
  calendarConnected: false,
  latestBriefing: null,
};

export function RailContent({
  tab,
  onTabChange,
  onClose,
  showClose = false,
  data,
}: {
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  onClose?: () => void;
  showClose?: boolean;
  data: RailData;
}) {
  const { data: session } = authClient.useSession();
  const { data: weather } = useWeather();
  const now = new Date();
  return (
    <>
      {/* Full-bleed condition-aware video behind the rail content. */}
      <WeatherVideoSurface condition={weather?.condition} isDay={weather?.isDay} />
      {/* Legibility stack — both scrims are DARK, because the rail content
       * is white. A neutral sky-to-night ramp darkens the lower body so the
       * feed and footer read, and a top vignette guarantees the header text
       * clears contrast on every condition.
       *
       * The header scrim is the load-bearing one: the sky videos are bright
       * at the top (rainy/cloudy ~170/255, and thunderstorm flashes blow out
       * to ~255), so a white text header floated on the raw frame. A black
       * top gradient pulls even a lightning flash under the ~118/255 white-on-
       * dark AA threshold. (The old stack lifted the top with WHITE, which
       * did the opposite — it washed the header out.) Apple Weather / the iOS
       * lock screen treat photo backdrops the same way. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.70)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.55),rgba(0,0,0,0.42)_38%,rgba(0,0,0,0.16)_72%,transparent)]" />

      <div className="relative z-10 flex h-full min-h-0 flex-col text-white">
        {/* Header — stacked rows so variable-length strings never collide.
         * The greeting + name owns the full first row and truncates; the
         * weather sits on its own row beneath it (icon + temp + city ·
         * condition); the date closes the block. The old single-row
         * layout let a long name, a long city, or a long condition word
         * shove the others around — separate rows make each one stable. */}
        <div className="px-4 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 truncate text-[15px] font-medium tracking-tight text-white">
              {greeting(now)}
              {firstName(session?.user) ? `, ${firstName(session?.user)}` : ""}
            </div>
            {showClose ? (
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClose}
                className={cn(
                  "size-7 shrink-0 inline-flex items-center justify-center rounded-lg",
                  "text-white/70 hover:bg-white/[0.07] hover:text-white transition-colors app-press",
                  "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                )}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          <WeatherLine />
          <div className="mt-1 text-[11.5px] uppercase tracking-tight font-medium text-white/60 mix-blend-plus-lighter">
            {formatRailDate(now)}
          </div>
        </div>

        <div className="px-4 pb-3">
          <AppSegmented<RailTab>
            value={tab}
            onValueChange={onTabChange}
            items={RAIL_TABS}
            label="Today filter"
            variant="glass"
          />
        </div>

        {/* Stacked feeds — all three render in the same grid cell so the
         * outgoing feed crossfades + lifts while the new feed settles in.
         * Same pattern as `HeroShowcase`'s `Slot`. The scroll container's
         * height is the MAX of all feeds, so a tab swap never re-flows
         * the rail. */}
        <div className="relative flex-1 min-h-0 overflow-y-auto px-3 pb-3">
          {/* Single-column track with `minmax(0, 1fr)` clamps every stacked
           * feed to the rail's width — otherwise the grid auto-sizes to its
           * widest child (the inbox rows), `truncate` stops working, and
           * narrower feeds like the to-do empty hint run past the rail's
           * visible edge. */}
          <div className="relative grid grid-cols-[minmax(0,1fr)]">
            <RailSlot active={tab === "todo"}>
              <TodoFeed
                items={data.todos}
                suggestions={data.todoSuggestions}
                onToggleTodo={data.onToggleTodo}
                onCreateTodo={data.onCreateTodo}
                onPromoteSuggestion={data.onPromoteSuggestion}
              />
            </RailSlot>
            <RailSlot active={tab === "inbox"}>
              <InboxFeed
                items={data.inbox}
                pagination={data.inboxPagination}
                selectedId={data.selectedInboxId ?? null}
                onOpen={data.onOpenInbox}
                onClose={data.onCloseInbox}
                onMarkRead={data.onMarkInboxRead}
                markReadPending={data.markInboxReadPending}
                triageTagsByThreadId={data.triageTagsByThreadId}
                onOverrideTag={data.onOverrideTriageTag}
              />
            </RailSlot>
            <RailSlot active={tab === "meetings"}>
              <MeetingsFeed
                items={data.meetings}
                lookahead={data.meetingLookahead}
                calendarConnected={data.calendarConnected ?? false}
              />
            </RailSlot>
          </div>
        </div>

        <RailFooter latestBriefing={data.latestBriefing ?? null} />
      </div>
    </>
  );
}

/* ---- helpers ---- */

function formatRailDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "short" });
  return `${weekday} · ${month} ${date.getDate()}`;
}
