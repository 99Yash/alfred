import { todos } from "@alfred/db/schemas";
import type {
  TodoClearArgs,
  TodoCompleteArgs,
  TodoCompleteSuggestionArgs,
  TodoCreateArgs,
  TodoDismissArgs,
  TodoEditArgs,
  TodoPromoteArgs,
  TodoReopenArgs,
} from "@alfred/sync";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTx, ServerMutatorCtx } from "./mutator";

// Todos (ADR-0050). User-authored creates + user-initiated lifecycle
// transitions. Alfred's proposals enter server-side via the
// `system.suggest_todo` tool, not here. Every transition is guarded on the
// source status so Replicache's at-least-once redelivery is a harmless no-op
// the second time.

/** Add a user-authored todo. Idempotent on id (client mints it before push). */
export async function todoCreate(
  tx: DbTx,
  args: TodoCreateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .insert(todos)
    .values({
      id: args.id,
      userId: ctx.userId,
      name: args.name,
      description: args.description ?? null,
      status: "open",
      createdBy: "user",
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}

/** Check the box: `open → done`, stamp `completed_at`. */
export async function todoComplete(
  tx: DbTx,
  args: TodoCompleteArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "done",
      completedAt: new Date(),
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "open")));
}

/**
 * Mark a suggestion done directly: `suggested → done`, stamp `completed_at`.
 * Provenance (`created_by`, `sources`, `assist`) is left untouched, so the
 * completed row keeps the suggestion's context. Guarded on `suggested`.
 */
export async function todoCompleteSuggestion(
  tx: DbTx,
  args: TodoCompleteSuggestionArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "done",
      completedAt: new Date(),
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "suggested")));
}

/** Uncheck the box: `done → open`, clear `completed_at`. */
export async function todoReopen(
  tx: DbTx,
  args: TodoReopenArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "open",
      completedAt: null,
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "done")));
}

/** Accept a suggestion: `suggested → open`. `created_by` is preserved. */
export async function todoPromote(
  tx: DbTx,
  args: TodoPromoteArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({ status: "open", rowVersion: sql`${todos.rowVersion} + 1` })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "suggested")));
}

/**
 * Decline a suggestion or drop an open todo → terminal `dismissed`. The pull
 * fetcher excludes `dismissed`, so the next pull deletes the client row.
 */
export async function todoDismiss(
  tx: DbTx,
  args: TodoDismissArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({ status: "dismissed", rowVersion: sql`${todos.rowVersion} + 1` })
    .where(
      and(
        eq(todos.id, args.id),
        eq(todos.userId, ctx.userId),
        inArray(todos.status, ["open", "suggested"]),
      ),
    );
}

/**
 * Personally clear a completed todo → terminal `cleared`. The pull fetcher
 * excludes `cleared` (like `dismissed`), so the next pull deletes the client
 * row. Guarded on `done` so it can't drop a live todo; reopening stays a
 * separate `done → open` transition.
 */
export async function todoClear(
  tx: DbTx,
  args: TodoClearArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(todos)
    .set({ status: "cleared", rowVersion: sql`${todos.rowVersion} + 1` })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "done")));
}

/** Edit a todo's name and/or description. */
export async function todoEdit(tx: DbTx, args: TodoEditArgs, ctx: ServerMutatorCtx): Promise<void> {
  await tx
    .update(todos)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId)));
}
