import { IDB_KEY, type SyncedTodo, syncedTodoSchema } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicacheStatus } from "./context";

export interface TodosState {
  /** Live todos (`open` first, then `done`), newest-created first within each. */
  todos: SyncedTodo[];
  /** Alfred's pending proposals (`suggested`), newest-created first. */
  suggestions: SyncedTodo[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Add a user-authored todo. Optimistic; the server confirms on next pull. */
  createTodo: (name: string, description?: string) => Promise<void>;
  /** Check the box (`open → done`). */
  completeTodo: (id: string) => Promise<void>;
  /** Uncheck the box (`done → open`). */
  reopenTodo: (id: string) => Promise<void>;
  /** Accept a suggestion (`suggested → open`). */
  promoteTodo: (id: string) => Promise<void>;
  /** Decline a suggestion or drop an open todo (terminal `dismissed`). */
  dismissTodo: (id: string) => Promise<void>;
  /** Edit a todo's name and/or description. */
  editTodo: (id: string, patch: { name?: string; description?: string | null }) => Promise<void>;
}

const STATUS_RANK: Record<SyncedTodo["status"], number> = {
  open: 0,
  done: 1,
  suggested: 2,
  dismissed: 3,
};

function sortTodos(a: SyncedTodo, b: SyncedTodo): number {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  }
  // Manual order takes precedence when present (forward-compat `position`),
  // otherwise fall back to creation order.
  if (a.position != null && b.position != null && a.position !== b.position) {
    return a.position - b.position;
  }
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Live view of the user's todos + Alfred's suggestions for the quick rail
 * (ADR-0050). `dismissed` rows never sync; `done` rows linger 7 days. Rows that
 * fail schema validation are dropped rather than crashing the rail.
 */
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
    const prefix = IDB_KEY.TODO({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedTodo[] = [];
        for (const value of values) {
          const result = syncedTodoSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort(sortTodos);
        setRows(parsed);
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
    [rep, userId],
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
    promoteTodo,
    dismissTodo,
    editTodo,
  };
}
