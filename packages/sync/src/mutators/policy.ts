import { LOADABLE_INTEGRATION_SLUGS, POLICY_MODES } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { syncedActionPolicySchema } from "../schemas";
import type { SyncedActionPolicy } from "../types";

export const policySetIntegrationModeArgsSchema = z.object({
  slug: z.enum(LOADABLE_INTEGRATION_SLUGS),
  mode: z.enum(POLICY_MODES),
});
export type PolicySetIntegrationModeArgs = z.infer<typeof policySetIntegrationModeArgsSchema>;

export async function policySetIntegrationModeClient(
  tx: WriteTransaction,
  args: PolicySetIntegrationModeArgs,
): Promise<void> {
  const prefix = IDB_KEY.ACTION_POLICY({});
  const [key] = await tx.scan({ prefix }).keys().toArray();
  if (!key) return;
  const result = syncedActionPolicySchema.safeParse(await tx.get(key));
  if (!result.success) return;
  const current = result.data;
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
