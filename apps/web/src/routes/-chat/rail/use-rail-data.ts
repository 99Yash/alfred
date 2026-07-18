import { scoreAttentionForItems, type AttentionBand, type TriageCategory } from "@alfred/contracts";
import type { SyncedTodo, SyncedTriageTag } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INBOX_PAGE_SIZE, useInbox, useMarkInboxRead, type InboxPage } from "./use-inbox";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
import { useMeetings } from "./use-meetings";
import { useRunBriefing } from "./use-run-briefing";
import { useTodos } from "~/lib/replicache/use-todos";
import { useTriageTags } from "~/lib/replicache/use-triage-tags";
import { toast } from "~/lib/toast";
import type { RailInboxItem, RailTodoItem } from "./models";
import { EMPTY_RAIL_DATA, type RailData } from "./rail-data";
import type { RailTodoSuggestion } from "./todo-feed";

// Module-level empties so the `?? EMPTY` fallback in `useRailData` returns a
// referentially stable value before react-query's first fetch resolves —
// otherwise every downstream callback / memo would churn on each render.
const EMPTY_INBOX_PAGES: ReadonlyArray<InboxPage> = [];
const EMPTY_INBOX_ITEMS: ReadonlyArray<RailInboxItem> = [];

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
export function useRailData(): RailData {
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
  }, [composing, briefing.data?.status]);
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
    const visible: RailTodoSuggestion[] = [];
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
  }, [safeInboxPage, inboxPageCount, pages, inbox.fetchNextPage]);

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
    [markInboxRead.mutate],
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
  items: ReadonlyArray<RailInboxItem>,
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>,
): ReadonlyArray<RailInboxItem> {
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
function toRailTodoItem(t: SyncedTodo): RailTodoItem {
  const provider = t.sources[0]?.provider;
  const source: RailTodoItem["source"] =
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
function toRailSuggestion(t: SyncedTodo): RailTodoSuggestion {
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
