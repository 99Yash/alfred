import { LOADABLE_INTEGRATION_SLUGS, POLICY_MODES } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { normalizeToReadonlyJSON, SYNC_MODEL } from "../sync-model";
import { syncedActionPolicySchema } from "../schemas";
import type { SyncedActionPolicy } from "../types";
import { readSyncedValue } from "./read";

export const policySetIntegrationModeArgsSchema = z.object({
  slug: z.enum(LOADABLE_INTEGRATION_SLUGS),
  mode: z.enum(POLICY_MODES),
});
export type PolicySetIntegrationModeArgs = z.infer<typeof policySetIntegrationModeArgsSchema>;

export async function policySetIntegrationModeClient(
  tx: WriteTransaction,
  args: PolicySetIntegrationModeArgs,
): Promise<void> {
  const prefix = SYNC_MODEL.ACTION_POLICY.prefix;
  const [key] = await tx.scan({ prefix }).keys().toArray();
  if (!key) return;
  const current = await readSyncedValue(tx, key, syncedActionPolicySchema);
  if (!current) return;
  const next: SyncedActionPolicy = {
    ...current,
    integrationRules: {
      ...current.integrationRules,
      [args.slug]: { ...current.integrationRules[args.slug], mode: args.mode },
    },
    rowVersion: current.rowVersion + 1,
  };
  await tx.set(key, normalizeToReadonlyJSON(next));
}

export const policySetDefaultModeArgsSchema = z.object({
  mode: z.enum(POLICY_MODES),
});
export type PolicySetDefaultModeArgs = z.infer<typeof policySetDefaultModeArgsSchema>;

/**
 * Flip the user's global approval default (`gated` ↔ `autonomy`). This is what
 * the chat "Auto" toggle drives: `autonomy` lets the dispatcher run tools
 * without staging a gated approval, so no card ever appears. Per-integration
 * rules still override the default (see `resolveIntegrationMode`).
 */
export async function policySetDefaultModeClient(
  tx: WriteTransaction,
  args: PolicySetDefaultModeArgs,
): Promise<void> {
  const prefix = SYNC_MODEL.ACTION_POLICY.prefix;
  const [key] = await tx.scan({ prefix }).keys().toArray();
  if (!key) return;
  const current = await readSyncedValue(tx, key, syncedActionPolicySchema);
  if (!current) return;
  const next: SyncedActionPolicy = {
    ...current,
    defaultMode: args.mode,
    rowVersion: current.rowVersion + 1,
  };
  await tx.set(key, normalizeToReadonlyJSON(next));
}
