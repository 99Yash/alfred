import type { TriageCategory } from "@alfred/contracts";
import type { SyncedTriageTag } from "@alfred/sync";
import type { RailInboxItem, RailMeetingItem, RailTodoItem } from "./models";
import type { MeetingLookaheadItem } from "./meetings-feed";
import type { RailTodoSuggestion } from "./todo-feed";

export interface RailBriefingSummary {
  /** Reserved for a future "view briefing" surface. */
  id: string;
  /** e.g. `"morning"` / `"evening"`. */
  slot: string;
  /** Local date (YYYY-MM-DD). */
  briefingDate: string;
  /** When the briefing was composed (ISO). */
  runAt: string;
  subject: string | null;
}

/** Inbox pagination. Absent in previews and fixtures. */
export interface InboxPagination {
  pageIndex: number;
  pageCount: number;
  total: number;
  isLoading: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export interface RailData {
  todos: ReadonlyArray<RailTodoItem>;
  todoSuggestions?: ReadonlyArray<RailTodoSuggestion> | undefined;
  /** Check or uncheck a todo (ADR-0050). `done` is the current state. */
  onToggleTodo?: ((id: string, done: boolean) => void) | undefined;
  /** `done` to `cleared`. */
  onClearTodo?: ((id: string) => void) | undefined;
  onCreateTodo?: ((title: string) => void) | undefined;
  /** `suggested` to `done`. */
  onCompleteSuggestion?: ((id: string) => void) | undefined;
  /** `suggested` to `open`. */
  onPromoteSuggestion?: ((id: string) => void) | undefined;
  /** `suggested` to `dismissed`. */
  onDismissSuggestion?: ((id: string) => void) | undefined;
  inbox: ReadonlyArray<RailInboxItem>;
  inboxPagination?: InboxPagination | undefined;
  /** Email open in the rail reader. */
  selectedInboxId?: string | null | undefined;
  onOpenInbox?: ((documentId: string) => void) | undefined;
  onCloseInbox?: (() => void) | undefined;
  /** Called with the visible unread ids. Omit it to hide the button. */
  onMarkInboxRead?: ((documentIds: ReadonlyArray<string>) => void) | undefined;
  markInboxReadPending?: boolean | undefined;
  /** Synced tags by Gmail thread id. Optimistic overrides go on top. */
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag> | undefined;
  onOverrideTriageTag?: ((threadId: string, category: TriageCategory) => void) | undefined;
  meetings: ReadonlyArray<RailMeetingItem>;
  meetingLookahead?: ReadonlyArray<MeetingLookaheadItem> | undefined;
  /** Separates "connect Calendar" from "day is clear"; both have zero items. */
  calendarConnected?: boolean | undefined;
  /** Null if no briefing has run yet. */
  latestBriefing?: RailBriefingSummary | null | undefined;
  /** On-demand briefing for the empty footer. Without it, the footer links to the timeline. */
  onGenerateBriefing?: (() => void) | undefined;
  /** Queued or composing; shows "Composing…". */
  briefingPending?: boolean | undefined;
}

export const EMPTY_RAIL_DATA: RailData = {
  todos: [],
  inbox: [],
  meetings: [],
  calendarConnected: false,
  latestBriefing: null,
};
