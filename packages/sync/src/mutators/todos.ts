import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { isoDateTimeStringSchema, syncedTodoSchema } from "../schemas";
import type { SyncedTodo } from "../types";
import { readSyncedValue } from "./read";

/**
 * Client-side todo mutators (ADR-0050). User-authored todos and user-initiated
 * lifecycle transitions are Replicache mutators; Alfred's proposals come in
 * server-side via `system.suggest_todo`. Each mutator applies an optimistic
 * patch the next pull rebases over the canonical row.
 *
 * Optimistic updates are best-effort: a transition that can't find its row
 * (rare post-refresh race) no-ops and lets the server pull take over.
 */

const todoId = z.string().min(1).max(100);

export const todoCreateArgsSchema = z.object({
  id: todoId,
  userId: z.string().min(1).max(100),
  name: z.string().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  createdAt: isoDateTimeStringSchema,
});
export type TodoCreateArgs = z.infer<typeof todoCreateArgsSchema>;

export const todoCompleteArgsSchema = z.object({ id: todoId });
export type TodoCompleteArgs = z.infer<typeof todoCompleteArgsSchema>;

export const todoReopenArgsSchema = z.object({ id: todoId });
export type TodoReopenArgs = z.infer<typeof todoReopenArgsSchema>;

export const todoPromoteArgsSchema = z.object({ id: todoId });
export type TodoPromoteArgs = z.infer<typeof todoPromoteArgsSchema>;

export const todoDismissArgsSchema = z.object({ id: todoId });
export type TodoDismissArgs = z.infer<typeof todoDismissArgsSchema>;

export const todoClearArgsSchema = z.object({ id: todoId });
export type TodoClearArgs = z.infer<typeof todoClearArgsSchema>;

export const todoCompleteSuggestionArgsSchema = z.object({ id: todoId });
export type TodoCompleteSuggestionArgs = z.infer<typeof todoCompleteSuggestionArgsSchema>;

export const todoEditArgsSchema = z
  .object({
    id: todoId,
    name: z.string().min(1).max(2_000).optional(),
    description: z.string().max(20_000).nullable().optional(),
  })
  .refine((args) => args.name !== undefined || args.description !== undefined, {
    message: "todoEdit requires at least one of name or description",
  });
export type TodoEditArgs = z.infer<typeof todoEditArgsSchema>;

async function readTodo(tx: WriteTransaction, id: string): Promise<SyncedTodo | null> {
  return readSyncedValue(tx, IDB_KEY.TODO({ id }), syncedTodoSchema);
}

async function writeTodo(tx: WriteTransaction, todo: SyncedTodo): Promise<void> {
  await tx.set(IDB_KEY.TODO({ id: todo.id }), normalizeToReadonlyJSON(todo));
}

/** Add a user-authored todo. Idempotent on id (a retry overwrites with the same row). */
export async function todoCreateClient(tx: WriteTransaction, args: TodoCreateArgs): Promise<void> {
  const value: SyncedTodo = {
    id: args.id,
    userId: args.userId,
    name: args.name,
    description: args.description ?? null,
    status: "open",
    createdBy: "user",
    executor: "user",
    kind: "task",
    assist: null,
    sources: [],
    agentRunId: null,
    completedAt: null,
    position: null,
    dueDate: null,
    rowVersion: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
  await writeTodo(tx, value);
}

/** Check the box: `open → done`, stamp `completedAt`. */
export async function todoCompleteClient(
  tx: WriteTransaction,
  args: TodoCompleteArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo || todo.status === "done") return;
  const now = new Date().toISOString();
  await writeTodo(tx, {
    ...todo,
    status: "done",
    completedAt: now,
    rowVersion: todo.rowVersion + 1,
    updatedAt: now,
  });
}

/** Uncheck the box: `done → open`, clear `completedAt`. */
export async function todoReopenClient(tx: WriteTransaction, args: TodoReopenArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo || todo.status !== "done") return;
  const now = new Date().toISOString();
  await writeTodo(tx, {
    ...todo,
    status: "open",
    completedAt: null,
    rowVersion: todo.rowVersion + 1,
    updatedAt: now,
  });
}

/**
 * Mark an Alfred-suggested todo done in one action: `suggested → done`, stamp
 * `completedAt`. Provenance (`createdBy`, `sources`, `assist`) rides along
 * untouched, so the completed row carries the same context as any other done
 * todo. The done row syncs (within the 7-day window) and lands in *Done*.
 */
export async function todoCompleteSuggestionClient(
  tx: WriteTransaction,
  args: TodoCompleteSuggestionArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo || todo.status !== "suggested") return;
  const now = new Date().toISOString();
  await writeTodo(tx, {
    ...todo,
    status: "done",
    completedAt: now,
    rowVersion: todo.rowVersion + 1,
    updatedAt: now,
  });
}

/** Accept a suggestion (`+`): `suggested → open`. `createdBy` is preserved. */
export async function todoPromoteClient(
  tx: WriteTransaction,
  args: TodoPromoteArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo || todo.status !== "suggested") return;
  const now = new Date().toISOString();
  await writeTodo(tx, {
    ...todo,
    status: "open",
    rowVersion: todo.rowVersion + 1,
    updatedAt: now,
  });
}

/**
 * Decline a suggestion or drop an open todo. `dismissed` rows never sync, so
 * the optimistic patch deletes the local row; the server moves it to
 * `status='dismissed'` and the next pull confirms the deletion.
 */
export async function todoDismissClient(
  tx: WriteTransaction,
  args: TodoDismissArgs,
): Promise<void> {
  const key = IDB_KEY.TODO({ id: args.id });
  if (!(await tx.has(key))) return;
  await tx.del(key);
}

/**
 * Personally clear a completed todo from the rail: `done → cleared`. Like
 * `dismissed`, `cleared` rows never sync, so the optimistic patch deletes the
 * local row; the server moves it to `status='cleared'` and the next pull
 * confirms the deletion. Guarded on `done` so it can't drop a live todo.
 */
export async function todoClearClient(tx: WriteTransaction, args: TodoClearArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo || todo.status !== "done") return;
  await tx.del(IDB_KEY.TODO({ id: args.id }));
}

/** Edit a todo's name and/or description. */
export async function todoEditClient(tx: WriteTransaction, args: TodoEditArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);
  if (!todo) return;
  const now = new Date().toISOString();
  await writeTodo(tx, {
    ...todo,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    rowVersion: todo.rowVersion + 1,
    updatedAt: now,
  });
}
