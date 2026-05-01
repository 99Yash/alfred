import { notes, rejectedInferences, userFacts } from "@alfred/db/schemas";
import type {
  FactConfirmArgs,
  FactEditArgs,
  FactRejectArgs,
  NoteCreateArgs,
} from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import { valueSignature } from "../memory/signature";

export interface ServerMutatorCtx {
  userId: string;
}

// Typed loosely so it accepts either the pool or a Drizzle tx handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

/**
 * Server-side mutators run inside the push handler's outer transaction
 * (via a per-mutator savepoint). Atomicity guarantees:
 *   - the mutator's writes commit together with the LMID advance, OR
 *   - the savepoint rolls back and the LMID still advances so the
 *     client doesn't re-queue the failed mutation forever.
 *
 * Memory primitives (`packages/api/src/modules/memory/*`) open their
 * own transactions via `db()`, which would escape this savepoint. The
 * fact mutators below re-implement the same logic inline against the
 * supplied `tx` so atomicity is preserved.
 */
export const serverMutators = {
  async noteCreate(tx: DbTx, args: NoteCreateArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .insert(notes)
      .values({
        id: args.id,
        userId: ctx.userId,
        text: args.text,
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
  },

  /**
   * Confirm a `proposed` row. No-op if the row is missing or already
   * past the proposed state — Replicache's at-least-once delivery means
   * confirm may arrive twice; the second is harmless.
   */
  async factConfirm(tx: DbTx, args: FactConfirmArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(userFacts)
      .set({ status: "confirmed", rowVersion: sql`${userFacts.rowVersion} + 1` })
      .where(
        and(
          eq(userFacts.id, args.factId),
          eq(userFacts.userId, ctx.userId),
          eq(userFacts.status, "proposed"),
        ),
      );
  },

  /**
   * Reject a fact: mark the row + record the (key, value) signature so
   * the extraction sub-agent doesn't re-propose it (ADR-0019).
   */
  async factReject(tx: DbTx, args: FactRejectArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
      .limit(1);
    if (!old) return;

    await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: new Date(),
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, args.factId));

    await tx
      .insert(rejectedInferences)
      .values({
        userId: ctx.userId,
        key: old.key,
        valueSignature: valueSignature(old.value),
        proposedFactId: old.id,
        reason: args.reason ? { note: args.reason } : null,
      })
      .onConflictDoNothing();
  },

  /**
   * User-edit: old row → `edited`, a new `confirmed` row replaces it
   * with `supersedes_id` linking back. Idempotent on `newFactId` —
   * the client mints it before pushing so a retry is a no-op.
   */
  async factEdit(tx: DbTx, args: FactEditArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
      .limit(1);
    if (!old) return;

    const now = new Date();
    await tx
      .update(userFacts)
      .set({
        status: "edited",
        validUntil: now,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, args.factId));

    await tx
      .insert(userFacts)
      .values({
        id: args.newFactId,
        userId: ctx.userId,
        key: old.key,
        value: args.newValue,
        confidence: 1,
        status: "confirmed",
        source: args.source ?? { kind: "user" },
        validFrom: now,
        validUntil: null,
        supersedesId: old.id,
      })
      .onConflictDoNothing();
  },
} as const;

export type ServerMutators = typeof serverMutators;
export type ServerMutatorName = keyof ServerMutators;
