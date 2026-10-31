import {
  LIVE_TODO_STATUSES,
  todoSourceSchema,
  type AttributionActor,
  type listTodosInput,
  type TodoSource,
  type TodoStatus,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { todoEvents, todos, type Todo } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";

/** Sources on one row of the result. `sourceCount` keeps the full count. */
const LIST_TODOS_MAX_SOURCES = 5;

/** The parsed `system.list_todos` input, for one user. */
export type ListTodosArgs = z.output<typeof listTodosInput> & { userId: string };

type ListedTodo = Pick<Todo, "id" | "name" | "status" | "dueDate"> & {
  /** The valid sources, at most {@link LIST_TODOS_MAX_SOURCES}, in stored order. */
  sources: TodoSource[];
  /** All stored sources, the invalid ones included. 0 when the stored value is not an array. */
  sourceCount: number;
  /**
   * The actor of the ADR-0115 creation event. Null for a todo created before ADR-0115 slice 1:
   * its creation is "not recorded".
   */
  creatorActor: AttributionActor | null;
};

export interface ListTodosResult {
  todos: ListedTodo[];
  status: ListTodosArgs["status"];
  limit: number;
  /** True when more todos match than `limit`. */
  truncated: boolean;
}

/**
 * Read the user's todos for `system.list_todos`, most recently changed first. Never writes.
 * `listTodosInput` caps the row count at `LIST_TODOS_MAX_LIMIT`. This task caps the sources
 * of each row at {@link LIST_TODOS_MAX_SOURCES}. So the result size has a bound.
 */
export async function listTodos(args: ListTodosArgs): Promise<ListTodosResult> {
  const { limit } = args;

  const statuses: readonly TodoStatus[] =
    args.status === "live" ? LIVE_TODO_STATUSES : [args.status];

  // Each todo has one creation event (`from_status` is null). A row with no `cause` is from
  // before ADR-0115 and carries no record, so it does not name the creator.
  const creation = db()
    .select({ todoId: todoEvents.todoId, actor: todoEvents.actor })
    .from(todoEvents)
    .where(
      and(
        eq(todoEvents.userId, args.userId),
        isNull(todoEvents.fromStatus),
        isNotNull(todoEvents.cause),
      ),
    )
    .as("creation");

  const rows = await db()
    .select({
      id: todos.id,
      name: todos.name,
      status: todos.status,
      dueDate: todos.dueDate,
      sources: todos.sources,
      creatorActor: creation.actor,
    })
    .from(todos)
    .leftJoin(creation, eq(creation.todoId, todos.id))
    .where(and(eq(todos.userId, args.userId), inArray(todos.status, statuses)))
    .orderBy(desc(todos.updatedAt), desc(todos.id))
    .limit(limit + 1);

  return {
    todos: rows
      .slice(0, limit)
      .map(({ sources, ...row }) => ({ ...row, ...readSources(row.id, sources) })),
    status: args.status,
    limit,
    truncated: rows.length > limit,
  };
}

/**
 * Read the stored `sources` jsonb as `unknown`. One invalid entry drops only that entry, so
 * the other sources stay visible and `sourceCount` stays the stored count.
 */
function readSources(todoId: string, stored: unknown): Pick<ListedTodo, "sources" | "sourceCount"> {
  if (!Array.isArray(stored)) {
    logger.warn({ todoId }, "[todos] list_todos: stored sources is not an array");

    return { sources: [], sourceCount: 0 };
  }

  const valid = stored.flatMap((entry: unknown) => {
    const parsed = todoSourceSchema.safeParse(entry);

    return parsed.success ? [parsed.data] : [];
  });

  const invalidCount = stored.length - valid.length;

  if (invalidCount > 0) {
    logger.warn({ todoId, invalidCount }, "[todos] list_todos: dropped invalid stored sources");
  }

  return { sources: valid.slice(0, LIST_TODOS_MAX_SOURCES), sourceCount: stored.length };
}
