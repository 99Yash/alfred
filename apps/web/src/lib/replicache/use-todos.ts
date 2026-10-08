import { SYNC_MODEL, type SyncedTodo } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicacheStatus } from "./context";

export interface TodosState {
  /** `open`, then `done`. */
  todos: SyncedTodo[];
  /** Alfred's `suggested` todos. */
  suggestions: SyncedTodo[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  createTodo: (name: string, description?: string) => Promise<void>;
  /** `open` to `done`. */
  completeTodo: (id: string) => Promise<void>;
  /** `done` to `open`. */
  reopenTodo: (id: string) => Promise<void>;
  /** `suggested` to `done`. */
  completeSuggestion: (id: string) => Promise<void>;
  /** `suggested` to `open`. */
  promoteTodo: (id: string) => Promise<void>;
  /** Terminal `dismissed`. */
  dismissTodo: (id: string) => Promise<void>;
  /** Terminal `cleared`: remove a done todo from the rail. */
  clearTodo: (id: string) => Promise<void>;
  editTodo: (id: string, patch: { name?: string; description?: string | null }) => Promise<void>;
}

const STATUS_RANK = {
  open: 0,
  done: 1,
  suggested: 2,
  dismissed: 3,
  // `cleared` never syncs; the rank only makes the map exhaustive.
  cleared: 4,
} satisfies Record<SyncedTodo["status"], number>;

function sortTodos(a: SyncedTodo, b: SyncedTodo): number {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  }

  // Manual `position` first, then newest created.
  if (a.position != null && b.position != null && a.position !== b.position) {
    return a.position - b.position;
  }

  return b.createdAt.localeCompare(a.createdAt);
}

/** Todos and suggestions for the rail (ADR-0050). `done` rows sync for 2 days. */
export function useTodos(): TodosState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rows, setRows] = useState<SyncedTodo[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setRows(null);

      return;
    }

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.todo.scan(tx),
      (todos) => {
        todos.sort(sortTodos);
        setRows(todos);
      },
    );
  }, [rep]);

  const createTodo = useCallback(
    async (name: string, description?: string): Promise<void> => {
      const trimmed = name.trim();

      if (!rep || !userId || !trimmed) return;
      await rep.mutate.todoCreate({
        id: crypto.randomUUID(),
        userId,
        name: trimmed,
        description: description?.trim() || undefined,
        createdAt: new Date().toISOString(),
      });
    },
    [rep, session?.user?.id],
  );

  const completeTodo = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoComplete({ id });
    },
    [rep],
  );

  const reopenTodo = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoReopen({ id });
    },
    [rep],
  );

  const completeSuggestion = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoCompleteSuggestion({ id });
    },
    [rep],
  );

  const promoteTodo = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoPromote({ id });
    },
    [rep],
  );

  const dismissTodo = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoDismiss({ id });
    },
    [rep],
  );

  const clearTodo = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoClear({ id });
    },
    [rep],
  );

  const editTodo = useCallback(
    async (id: string, patch: { name?: string; description?: string | null }): Promise<void> => {
      if (!rep) return;
      await rep.mutate.todoEdit({ id, ...patch });
    },
    [rep],
  );

  const { todos, suggestions } = useMemo(() => {
    const all = rows ?? [];

    return {
      todos: all.filter((t) => t.status === "open" || t.status === "done"),
      suggestions: all.filter((t) => t.status === "suggested"),
    };
  }, [rows]);

  return {
    todos,
    suggestions,
    loading: rows === null && !loadError,
    error: loadError,
    retry,
    createTodo,
    completeTodo,
    reopenTodo,
    completeSuggestion,
    promoteTodo,
    dismissTodo,
    clearTodo,
    editTodo,
  };
}
