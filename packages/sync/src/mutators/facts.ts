import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import type { SyncedFact } from "../types";

/**
 * Client-side mutators for the memory correction loop (ADR-0019).
 *
 * Every mutator below has two jobs:
 *   1. Validate args (zod schema, also used server-side via `mutatorArgsSchemas`).
 *   2. Apply an optimistic patch so the UI reflects the change before the
 *      next server pull lands. Server-side mutators in `@alfred/api`
 *      mirror these — when the server pull arrives, Replicache rebases
 *      our optimistic patch over the canonical state.
 *
 * The optimistic update is best-effort: if the corresponding row isn't
 * already in the local store (rare race after a refresh), the mutator
 * no-ops on the client and lets the server's authoritative pull take over.
 */

const factSourceSchema = z.record(z.string(), z.unknown());

export const factConfirmArgsSchema = z.object({
  factId: z.string().min(1).max(100),
});
export type FactConfirmArgs = z.infer<typeof factConfirmArgsSchema>;

export const factRejectArgsSchema = z.object({
  factId: z.string().min(1).max(100),
  /** Free-form rejection reason ("wrong person", "no longer true"). */
  reason: z.string().max(2_000).optional(),
});
export type FactRejectArgs = z.infer<typeof factRejectArgsSchema>;

const factValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const factEditArgsSchema = z.object({
  factId: z.string().min(1).max(100),
  /**
   * The replacement row id — the client mints it (`crypto.randomUUID()`)
   * so the optimistic patch can put a row immediately. Server uses the
   * same id when persisting via memory primitives.
   */
  newFactId: z.string().min(1).max(100),
  newValue: factValueSchema,
  /** Optional source override; defaults to `{ kind: 'user' }` server-side. */
  source: factSourceSchema.optional(),
});
export type FactEditArgs = z.infer<typeof factEditArgsSchema>;

async function readFact(tx: WriteTransaction, factId: string): Promise<SyncedFact | null> {
  const value = await tx.get(IDB_KEY.FACT({ id: factId }));
  if (!value) return null;
  return value as unknown as SyncedFact;
}

async function writeFact(tx: WriteTransaction, fact: SyncedFact): Promise<void> {
  await tx.set(IDB_KEY.FACT({ id: fact.id }), normalizeToReadonlyJSON(fact));
}

/**
 * Optimistic confirm: bump status, increment rowVersion. The next pull
 * will overwrite with the server's authoritative version (which uses
 * the same shape, just sourced from `user_facts`).
 */
export async function factConfirmClient(
  tx: WriteTransaction,
  args: FactConfirmArgs,
): Promise<void> {
  const fact = await readFact(tx, args.factId);
  if (!fact) return;
  if (fact.status !== "proposed") return;
  await writeFact(tx, { ...fact, status: "confirmed", rowVersion: fact.rowVersion + 1 });
}

/**
 * Optimistic reject: drop the row from the local store. Server moves
 * the row to `status='rejected'` (which we don't sync) and writes a
 * rejected_inferences row.
 */
export async function factRejectClient(tx: WriteTransaction, args: FactRejectArgs): Promise<void> {
  const key = IDB_KEY.FACT({ id: args.factId });
  const exists = await tx.has(key);
  if (!exists) return;
  await tx.del(key);
}

/**
 * Optimistic edit: drop the old row, drop a synthesized `confirmed` row
 * under the new id. Server does the same via `editFact` (old → 'edited',
 * new row → 'confirmed' linked via supersedesId). A short timestamp gap
 * is OK because the next pull will replace these placeholders.
 */
export async function factEditClient(tx: WriteTransaction, args: FactEditArgs): Promise<void> {
  const old = await readFact(tx, args.factId);
  if (!old) return;
  await tx.del(IDB_KEY.FACT({ id: args.factId }));

  const now = new Date().toISOString();
  const replacement: SyncedFact = {
    id: args.newFactId,
    userId: old.userId,
    key: old.key,
    value: args.newValue,
    confidence: 1,
    status: "confirmed",
    source: args.source ?? { kind: "user" },
    validFrom: now,
    validUntil: null,
    supersedesId: old.id,
    rowVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeFact(tx, replacement);
}
