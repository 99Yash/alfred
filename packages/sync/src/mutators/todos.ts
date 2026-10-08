import { isoDateTimeStringSchema } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import type { SyncedTodo } from "../schemas";

// Todo mutators (ADR-0050). A missing local row is a no-op; the next pull fixes it.

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
  return SYNC_MODEL.todo.get(tx, { id });
}

async function writeTodo(tx: WriteTransaction, todo: SyncedTodo): Promise<void> {
  await SYNC_MODEL.todo.put(tx, todo);
}

/** Idempotent on id. */
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

export async function todoCompleteClient(
  tx: WriteTransaction,
  args: TodoCompleteArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo || todo.status === "done") return;
  // Transitions leave `updatedAt` to the server. Nothing on the client reads it.
  await writeTodo(tx, {
    ...todo,
    status: "done",
    completedAt: new Date().toISOString(),
    rowVersion: todo.rowVersion + 1,
  });
}

export async function todoReopenClient(tx: WriteTransaction, args: TodoReopenArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo || todo.status !== "done") return;
  await writeTodo(tx, {
    ...todo,
    status: "open",
    completedAt: null,
    rowVersion: todo.rowVersion + 1,
  });
}

/** Mark a suggestion done in one step. Keeps its provenance. */
export async function todoCompleteSuggestionClient(
  tx: WriteTransaction,
  args: TodoCompleteSuggestionArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo || todo.status !== "suggested") return;
  await writeTodo(tx, {
    ...todo,
    status: "done",
    completedAt: new Date().toISOString(),
    rowVersion: todo.rowVersion + 1,
  });
}

/** Accept a suggestion. */
export async function todoPromoteClient(
  tx: WriteTransaction,
  args: TodoPromoteArgs,
): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo || todo.status !== "suggested") return;
  await writeTodo(tx, {
    ...todo,
    status: "open",
    rowVersion: todo.rowVersion + 1,
  });
}

/** Delete locally: `dismissed` rows do not sync. */
export async function todoDismissClient(
  tx: WriteTransaction,
  args: TodoDismissArgs,
): Promise<void> {
  await SYNC_MODEL.todo.del(tx, { id: args.id });
}

/** Clear a done todo. `cleared` rows do not sync. Only `done` rows, so a live todo stays. */
export async function todoClearClient(tx: WriteTransaction, args: TodoClearArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo || todo.status !== "done") return;
  await SYNC_MODEL.todo.del(tx, { id: args.id });
}

export async function todoEditClient(tx: WriteTransaction, args: TodoEditArgs): Promise<void> {
  const todo = await readTodo(tx, args.id);

  if (!todo) return;
  await writeTodo(tx, {
    ...todo,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    rowVersion: todo.rowVersion + 1,
  });
}
