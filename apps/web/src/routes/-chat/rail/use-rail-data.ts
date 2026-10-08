import {
  INBOX_DEFAULT_LIMIT,
  scoreAttentionForItems,
  type AttentionBand,
  type TriageCategory,
} from "@alfred/contracts";
import type { SyncedTodo, SyncedTriageTag } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInbox, useMarkInboxRead, type InboxPage } from "./use-inbox";
import { useLatestBriefing } from "~/hooks/use-latest-briefing";
import { useMeetings } from "./use-meetings";
import { useRunBriefing } from "./use-run-briefing";
import { useTodos } from "~/lib/replicache/use-todos";
import { useTriageTags } from "~/lib/replicache/use-triage-tags";
import { toast } from "~/lib/toast";
import type { RailInboxItem, RailTodoItem } from "./models";
import { EMPTY_RAIL_DATA, type RailData } from "./rail-data";
import type { RailTodoSuggestion } from "./todo-feed";

// Stable empty fallbacks, so memos do not churn before the first fetch.
const EMPTY_INBOX_PAGES: ReadonlyArray<InboxPage> = [];

const EMPTY_INBOX_ITEMS: ReadonlyArray<RailInboxItem> = [];

/** Data for the right rail's tabs and footer: inbox, meetings, todos, and the latest briefing. */
export function useRailData(): RailData {
  const inbox = useInbox();
  const meetings = useMeetings();
  // On-demand briefing: `composing` shows "Composing…" and polls until the run lands or fails.
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

  // Live todos and suggestions (ADR-0050).
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

  // Hide at once; commit `dismissed` after the undo window, so Undo is local.
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

  // Walks the cached pages; going past the last one calls `fetchNextPage`.
  const [inboxPageIndex, setInboxPageIndex] = useState(0);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);

  const pages = useMemo(() => inbox.data?.pages ?? EMPTY_INBOX_PAGES, [inbox.data?.pages]);
  const total = pages[0]?.total ?? 0;
  const inboxPageCount = Math.max(1, Math.ceil(total / INBOX_DEFAULT_LIMIT));
  // Clamp during render when invalidation drops the total below the current index.
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

    // Do not wait for the fetch; InboxFeed shows a spinner until the page lands.
    if (!pages[target]) void fetchNextPage();
    setInboxPageIndex(target);
  }, [safeInboxPage, inboxPageCount, pages, inbox.fetchNextPage]);

  const onOpenInbox = useCallback((documentId: string) => {
    setSelectedInboxId(documentId);
  }, []);

  const onCloseInbox = useCallback(() => setSelectedInboxId(null), []);

  // `useMarkInboxRead` invalidates ["me","inbox"] on success.
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

/** Demanding first, muted last; server order within a band. */
const ATTENTION_BAND_ORDER = {
  demanding: 0,
  normal: 1,
  muted: 2,
} satisfies Record<AttentionBand, number>;

/**
 * Overlay synced triage tags on inbox rows, then sort by attention band (ADR-0064 / #210).
 * The band is derived, never stored, with the briefing's scorer. Recurrence needs the whole page.
 */
function overlayTriageTags(
  items: ReadonlyArray<RailInboxItem>,
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>,
): ReadonlyArray<RailInboxItem> {
  if (items.length === 0) return items;

  const merged = items.map((item) => {
    const tag = item.threadId ? tagsByThreadId.get(item.threadId) : undefined;

    if (!tag) return { item, significanceBand: null };

    const withTag =
      item.category === tag.category && item.categorySource === tag.source
        ? item
        : { ...item, category: tag.category, categorySource: tag.source };

    return { item: withTag, significanceBand: tag.senderSignificanceBand };
  });

  // Score the page together so cross-row recurrence works. Untriaged rows get no band.
  const scored = scoreAttentionForItems(
    merged.map(({ item, significanceBand }) => ({
      // The bare address shows bulk mailboxes and keys recurrence.
      sender: item.senderAddress ?? item.sender,
      subject: item.subject,
      category: item.category ?? "fyi",
      significanceBand,
      // The rail is newest-first; without this the latest repeat would stay demanding.
      occurredAtMs: item.authoredAtMs,
    })),
  );

  const withBand = merged.map(({ item }, i) => {
    const band: AttentionBand | null = item.category ? (scored[i]?.band ?? null) : null;

    return item.attentionBand === band ? item : { ...item, attentionBand: band };
  });

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

/** `assist` becomes the subtitle. */
function toRailSuggestion(t: SyncedTodo): RailTodoSuggestion {
  return { id: t.id, label: t.name, detail: t.assist ?? "" };
}

const SUGGESTION_UNDO_MS = 5000;

/**
 * Hide a suggestion at once; send `todoDismiss` after the undo window, so Undo is local.
 * Dismissed rows never sync back. A pending dismissal commits on unmount.
 */
interface SuggestionDismissal {
  hiddenSuggestionIds: ReadonlySet<string>;
  onDismissSuggestion: (id: string) => void;
}

function useSuggestionDismissal(
  suggestions: ReadonlyArray<SyncedTodo>,
  dismissTodo: (id: string) => Promise<void>,
): SuggestionDismissal {
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
