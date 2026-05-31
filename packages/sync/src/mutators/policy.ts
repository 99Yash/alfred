import { INTEGRATION_SLUGS, POLICY_MODES } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import type { SyncedActionPolicy } from "../types";

/**
 * Client-side mutator for the per-integration policy editor (m13 Phase 8c).
 *
 * The user_action_policies row is one synced entity keyed by `userId`, so
 * the optimistic patch doesn't need the id in its args: it scans the
 * `actionpolicy/` prefix (there is at most one row), sets the chosen
 * integration's `mode`, and bumps `rowVersion`. The server mutator does
 * the canonical write + `publishPolicyBust`; the next pull rebases.
 *
 * If no row is in the local store yet (cold client before the first pull),
 * the optimistic write is skipped — the server write still lands and the
 * pull brings the row down. We never fabricate a row client-side because
 * the userId and the other fields (defaultMode, delay) aren't known here.
 */

export const policySetIntegrationModeArgsSchema = z.object({
  slug: z.enum(INTEGRATION_SLUGS),
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
  const current = (await tx.get(key)) as SyncedActionPolicy | undefined;
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
