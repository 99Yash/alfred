import { todos, type Todo } from "@alfred/db/schemas";
import { syncedTodoSchema, type SyncedTodo } from "@alfred/sync";
import { and, asc, eq, gte, ne, notInArray, or } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

/** Done todos linger this long in the sync window before falling out (ADR-0050). */
const TODO_DONE_WINDOW_DAYS = 2;

// ADR-0050. `dismissed` + `cleared` rows never reach the client; `done` rows
// linger `TODO_DONE_WINDOW_DAYS` then fall out of the pull window (not the
// DB). `suggested` + `open` always sync. `cleared` (#297) is a `done` the
// user removed from the rail early — terminal, so excluded like `dismissed`.
const serializeTodo = defineSerializer<Todo, SyncedTodo>(syncedTodoSchema, (t) => {
  if (t.status === "dismissed") {
    throw new SerializationError("cannot sync a dismissed todo");
  }
  return {
    id: t.id,
    userId: t.userId,
    name: t.name,
    description: t.description,
    status: t.status,
    createdBy: t.createdBy,
    executor: t.executor,
    kind: t.kind,
    assist: t.assist,
    sources: t.sources,
    agentRunId: t.agentRunId,
    completedAt: t.completedAt,
    position: t.position,
    dueDate: t.dueDate,
    rowVersion: t.rowVersion,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
});

export const fetchTodos = defineFetcher<Todo>({
  slug: "TODO",
  query: (tx, userId) => {
    const doneCutoff = new Date(Date.now() - TODO_DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return tx
      .select()
      .from(todos)
      .where(
        and(
          eq(todos.userId, userId),
          notInArray(todos.status, ["dismissed", "cleared"]),
          or(ne(todos.status, "done"), gte(todos.completedAt, doneCutoff)),
        ),
      )
      .orderBy(asc(todos.createdAt), asc(todos.id));
  },
  idOf: (t) => t.id,
  versionOf: (t) => t.rowVersion,
  serialize: serializeTodo,
});
