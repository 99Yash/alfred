import { confirmFact, createFact, editFact, rejectFact } from "@alfred/assistant/knowledge";
import type { DbTransaction } from "@alfred/db";
import type { FactConfirmArgs, FactCreateArgs, FactEditArgs, FactRejectArgs } from "@alfred/sync";

/**
 * Each mutator runs in a savepoint; on failure the LMID still advances. The fact owner in
 * `@alfred/assistant/knowledge` runs on the savepoint `tx`; push pokes after commit.
 */

/** Confirm a `proposed` row. A repeat is a no-op. */
export async function factConfirm(
  tx: DbTransaction,
  args: FactConfirmArgs,
  userId: string,
): Promise<void> {
  await confirmFact({ factId: args.factId, userId, exec: tx });
}

/** A user's own fact. Idempotent on the client id. The owner is the session user, never `args.userId`. */
export async function factCreate(
  tx: DbTransaction,
  args: FactCreateArgs,
  userId: string,
): Promise<void> {
  await createFact({
    id: args.id,
    userId,
    key: args.key,
    value: args.value,
    source: args.source,
    exec: tx,
  });
}

/** Also record the (key, value) signature so extraction does not propose it again (ADR-0019). */
export async function factReject(
  tx: DbTransaction,
  args: FactRejectArgs,
  userId: string,
): Promise<void> {
  await rejectFact({
    factId: args.factId,
    userId,
    reason: args.reason ? { note: args.reason } : undefined,
    exec: tx,
  });
}

/** The old row becomes `edited`; a new row links back by `supersedes_id`. Idempotent on `newFactId`. */
export async function factEdit(
  tx: DbTransaction,
  args: FactEditArgs,
  userId: string,
): Promise<void> {
  await editFact({
    factId: args.factId,
    userId,
    newValue: args.newValue,
    newFactId: args.newFactId,
    source: args.source,
    exec: tx,
  });
}
