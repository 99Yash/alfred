import type { TriageCategory } from "@alfred/contracts";
import type { SyncedTriageTag } from "@alfred/sync";
import type { InboxItem, MeetingItem, TodoItem } from "./helpers";
import type { MeetingLookaheadItem } from "./meetings-feed";
import type { SuggestionInput } from "./todo-feed";

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
 * surfaces previous/next controls and the chat shell owns the page index; when absent
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
  /** Clear a completed todo from the rail (`done` to `cleared`). */
  onClearTodo?: (id: string) => void;
  /** Add a user-authored todo from the rail's add row. */
  onCreateTodo?: (title: string) => void;
  /** Mark a suggestion done directly (`suggested` to `done`). */
  onCompleteSuggestion?: (id: string) => void;
  /** Accept a suggestion (`suggested` to `open`). */
  onPromoteSuggestion?: (id: string) => void;
  /** Decline a suggestion (`suggested` to `dismissed`). */
  onDismissSuggestion?: (id: string) => void;
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
   * to `useMarkInboxRead()`. Optional; the preview route omits it, in
   * which case the button is a no-op (and we hide it).
   */
  onMarkInboxRead?: (documentIds: ReadonlyArray<string>) => void;
  /** True while a mark-read mutation is in flight; disables the button. */
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
   * connected, day is clear"; both render zero items.
   */
  calendarConnected?: boolean;
  /** Latest composed briefing for the user, or null if none has run yet. */
  latestBriefing?: RailBriefingSummary | null;
  /**
   * Trigger an on-demand briefing run (the footer's "Generate briefing"
   * button, shown only in the empty state). Optional — the preview route
   * omits it, in which case the empty footer links to the timeline instead.
   */
  onGenerateBriefing?: () => void;
  /** True while a manual briefing run is queued or composing; shows "Composing…". */
  briefingPending?: boolean;
}

export const EMPTY_RAIL_DATA: RailData = {
  todos: [],
  inbox: [],
  meetings: [],
  calendarConnected: false,
  latestBriefing: null,
};
