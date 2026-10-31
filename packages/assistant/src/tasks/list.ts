import {
  LIST_TODOS_MAX_LIMIT,
  todoSourcesSchema,
  type AttributionActor,
  type LIST_TODOS_STATUS_FILTERS,
  type TodoSource,
  type TodoStatus,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { todoEvents, todos, type Todo } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/** Sources on one row of the result. `sourceCount` keeps the full count. */
const LIST_TODOS_MAX_SOURCES = 5;

type ListTodosStatusFilter = (typeof LIST_TODOS_STATUS_FILTERS)[number];

export interface ListTodosArgs {
  userId: string;
  status: ListTodosStatusFilter;
  limit: number;
}

type ListedTodo = Pick<Todo, "id" | "name" | "status" | "dueDate"> & {
  /** At most {@link LIST_TODOS_MAX_SOURCES}, in stored order. */
  sources: TodoSource[];
  sourceCount: number;
  /**
   * The actor of the ADR-0115 creation event. Null for a todo created before ADR-0115 slice 1:
   * its creation is "not recorded".
   */
  creatorActor: AttributionActor | null;
};

export interface ListTodosResult {
  todos: ListedTodo[];
  status: ListTodosStatusFilter;
  limit: number;
  /** True when more todos match than `limit`. */
  truncated: boolean;
}

/**
 * Read the user's todos for `system.list_todos`, most recently changed first. Never writes.
 * The row count is capped at {@link LIST_TODOS_MAX_LIMIT} and the sources of each row at
 * {@link LIST_TODOS_MAX_SOURCES}, so the result size has a bound.
 */
export async function listTodos(args: ListTodosArgs): Promise<ListTodosResult> {
  const limit = Math.min(Math.max(1, Math.trunc(args.limit)), LIST_TODOS_MAX_LIMIT);
  const statuses: TodoStatus[] = args.status === "live" ? ["suggested", "open"] : [args.status];

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
    todos: rows.slice(0, limit).map(({ sources, ...row }) => {
      const parsed = todoSourcesSchema.safeParse(sources);
      const all = parsed.success ? parsed.data : [];

      return { ...row, sources: all.slice(0, LIST_TODOS_MAX_SOURCES), sourceCount: all.length };
    }),
    status: args.status,
    limit,
    truncated: rows.length > limit,
  };
}
