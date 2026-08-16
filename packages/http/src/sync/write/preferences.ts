import { deletePreferenceRow, upsertPreference } from "@alfred/assistant/settings";
import type { PrefDeleteArgs, PrefSetArgs } from "@alfred/sync";
import type { DbTx, ServerMutatorCtx } from "./mutator";

/**
 * Upsert a preference. Last-write-wins per `(user_id, key)`; bumps
 * `row_version` so the next pull patches the client.
 *
 * Routed through `settings.upsertPreference` against `tx` rather than the
 * `setPreference()` gateway (which opens its own `db()` handle) so the write
 * commits inside the push handler's outer transaction. Awaited bare — no
 * `RETURNING` — so the emitted SQL is identical to the former inline.
 */
export async function prefSet(tx: DbTx, args: PrefSetArgs, ctx: ServerMutatorCtx): Promise<void> {
  await upsertPreference(tx, {
    userId: ctx.userId,
    key: args.key,
    value: args.value,
    source: args.source,
  });
}

/** Delete a preference. No-op if missing. */
export async function prefDelete(
  tx: DbTx,
  args: PrefDeleteArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await deletePreferenceRow(tx, ctx.userId, args.key);
}
