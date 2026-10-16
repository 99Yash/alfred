import { settings } from "@alfred/assistant/settings";
import type { PrefDeleteArgs, PrefSetArgs } from "@alfred/sync";
import type { DbTransaction } from "@alfred/db";

/** Last write wins. The bind writes on `tx`, so the row commits with the push transaction. */
export async function prefSet(tx: DbTransaction, args: PrefSetArgs, userId: string): Promise<void> {
  await settings({ userId, exec: tx }).set(args.key, args.value, { source: args.source });
}

export async function prefDelete(
  tx: DbTransaction,
  args: PrefDeleteArgs,
  userId: string,
): Promise<void> {
  await settings({ userId, exec: tx }).delete(args.key);
}
