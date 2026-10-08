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
import type { DbTransaction } from "@alfred/db";

// ADR-0050. Each transition checks the source status, so a redelivery is a no-op.

export async function todoCreate(
  tx: DbTransaction,
  args: TodoCreateArgs,
  userId: string,
): Promise<void> {
  await tx
    .insert(todos)
    .values({
      id: args.id,
      userId,
      name: args.name,
      description: args.description ?? null,
      status: "open",
      createdBy: "user",
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}

export async function todoComplete(
  tx: DbTransaction,
  args: TodoCompleteArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "done",
      completedAt: new Date(),
      resolvedBy: "user",
      resolvedReason: "completed",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId), eq(todos.status, "open")));
}

/** `suggested → done`. Keeps the suggestion's provenance. */
export async function todoCompleteSuggestion(
  tx: DbTransaction,
  args: TodoCompleteSuggestionArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "done",
      completedAt: new Date(),
      resolvedBy: "user",
      resolvedReason: "completed",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId), eq(todos.status, "suggested")));
}

export async function todoReopen(
  tx: DbTransaction,
  args: TodoReopenArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "open",
      completedAt: null,
      resolvedBy: "user",
      resolvedReason: "reopened",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId), eq(todos.status, "done")));
}

export async function todoPromote(
  tx: DbTransaction,
  args: TodoPromoteArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "open",
      resolvedBy: "user",
      resolvedReason: "promoted",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId), eq(todos.status, "suggested")));
}

export async function todoDismiss(
  tx: DbTransaction,
  args: TodoDismissArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "dismissed",
      resolvedBy: "user",
      resolvedReason: "dismissed",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(
      and(
        eq(todos.id, args.id),
        eq(todos.userId, userId),
        inArray(todos.status, ["open", "suggested"]),
      ),
    );
}

/** `done → cleared`. Only from `done`, so it cannot drop a live todo. */
export async function todoClear(
  tx: DbTransaction,
  args: TodoClearArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      status: "cleared",
      resolvedBy: "user",
      resolvedReason: "cleared",
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId), eq(todos.status, "done")));
}

export async function todoEdit(
  tx: DbTransaction,
  args: TodoEditArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(todos)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(and(eq(todos.id, args.id), eq(todos.userId, userId)));
}
