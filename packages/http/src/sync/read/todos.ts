import { todos, type Todo } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, gte, inArray, ne, notInArray, or } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

const TODO_DONE_WINDOW_DAYS = 2;

// ADR-0050. `done` rows sync for a short window; `dismissed` and `cleared` never sync.
// The cutoff uses `readAt`, so both stages agree.
const visibleTo = (userId: string, readAt: Date) => {
  const doneCutoff = new Date(readAt.getTime() - TODO_DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return and(
    eq(todos.userId, userId),
    notInArray(todos.status, ["dismissed", "cleared"]),
    or(ne(todos.status, "done"), gte(todos.completedAt, doneCutoff)),
  );
};

export const fetchTodos = syncEntity(SYNC_MODEL.todo, {
  versionQuery: (tx, userId, readAt) =>
    tx
      .select({ id: todos.id, rowVersion: todos.rowVersion })
      .from(todos)
      .where(visibleTo(userId, readAt))
      .orderBy(asc(todos.createdAt), asc(todos.id)),
  loadQuery: (tx, userId, changed, readAt) =>
    tx
      .select()
      .from(todos)
      .where(
        and(
          visibleTo(userId, readAt),
          inArray(
            todos.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(todos.createdAt), asc(todos.id)),
  map: (t: Todo) => {
    if (t.status === "dismissed") {
      throw new SerializationError("cannot sync a dismissed todo");
    }

    return t;
  },
});
