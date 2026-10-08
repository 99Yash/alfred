import { deletePreferenceRow, upsertPreference } from "@alfred/assistant/settings";
import type { PrefDeleteArgs, PrefSetArgs } from "@alfred/sync";
import type { DbTransaction } from "@alfred/db";

/** Last write wins. Uses `upsertPreference` on `tx`, not `setPreference()`, which opens its own `db()`. */
export async function prefSet(tx: DbTransaction, args: PrefSetArgs, userId: string): Promise<void> {
  await upsertPreference(tx, {
    userId,
    key: args.key,
    value: args.value,
    source: args.source,
  });
}

export async function prefDelete(
  tx: DbTransaction,
  args: PrefDeleteArgs,
  userId: string,
): Promise<void> {
  await deletePreferenceRow(tx, userId, args.key);
}
