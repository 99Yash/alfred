import { LOADABLE_INTEGRATION_SLUGS, POLICY_MODES } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import type { SyncedActionPolicy } from "../schemas";

export const policySetIntegrationModeArgsSchema = z.object({
  slug: z.enum(LOADABLE_INTEGRATION_SLUGS),
  mode: z.enum(POLICY_MODES),
});

export type PolicySetIntegrationModeArgs = z.infer<typeof policySetIntegrationModeArgsSchema>;

export async function policySetIntegrationModeClient(
  tx: WriteTransaction,
  args: PolicySetIntegrationModeArgs,
): Promise<void> {
  const [current] = await SYNC_MODEL.actionpolicy.scan(tx);

  if (!current) return;

  const next: SyncedActionPolicy = {
    ...current,
    integrationRules: {
      ...current.integrationRules,
      [args.slug]: { ...current.integrationRules[args.slug], mode: args.mode },
    },
    rowVersion: current.rowVersion + 1,
  };

  await SYNC_MODEL.actionpolicy.put(tx, next);
}

export const policySetDefaultModeArgsSchema = z.object({
  mode: z.enum(POLICY_MODES),
});

export type PolicySetDefaultModeArgs = z.infer<typeof policySetDefaultModeArgsSchema>;

/** Set the global approval default (the chat "Auto" toggle). Per-integration rules still win. */
export async function policySetDefaultModeClient(
  tx: WriteTransaction,
  args: PolicySetDefaultModeArgs,
): Promise<void> {
  const [current] = await SYNC_MODEL.actionpolicy.scan(tx);

  if (!current) return;

  const next: SyncedActionPolicy = {
    ...current,
    defaultMode: args.mode,
    rowVersion: current.rowVersion + 1,
  };

  await SYNC_MODEL.actionpolicy.put(tx, next);
}
