import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "@alfred/assistant/action-policies";
import type { IntegrationRules } from "@alfred/contracts";
import { userActionPolicies } from "@alfred/db/schemas";
import type { PolicySetDefaultModeArgs, PolicySetIntegrationModeArgs } from "@alfred/sync";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";

/**
 * Rules for a user with no row yet. Must match `ensureDefaultActionPolicyForUser`.
 * `system` is a backstop: `resolvePolicyMode` never gates `system.*` (ADR-0040).
 */
const DEFAULT_INTEGRATION_RULES: IntegrationRules = {
  system: { mode: "autonomy" },
};

export async function policySetIntegrationMode(
  tx: DbTransaction,
  args: PolicySetIntegrationModeArgs,
  userId: string,
): Promise<void> {
  const insertedRules: IntegrationRules = {
    ...DEFAULT_INTEGRATION_RULES,
    [args.slug]: { mode: args.mode },
  };

  await tx
    .insert(userActionPolicies)
    .values({
      userId,
      defaultMode: "gated",
      integrationRules: insertedRules,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        // Keep the `::text` casts: Postgres cannot infer an untyped parameter inside `jsonb_build_object`.
        integrationRules: sql`jsonb_set(
            ${userActionPolicies.integrationRules} ||
              jsonb_build_object(
                ${args.slug}::text,
                COALESCE(${userActionPolicies.integrationRules}->${args.slug}::text, '{}'::jsonb)
              ),
            ARRAY[${args.slug}::text, 'mode'],
            to_jsonb(${args.mode}::text),
            true
          )`,
        rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
      },
    });
}

/** Its `followUp` busts the policy cache after commit, so the flip applies on the next tool call. */
export async function policySetDefaultMode(
  tx: DbTransaction,
  args: PolicySetDefaultModeArgs,
  userId: string,
): Promise<void> {
  await tx
    .insert(userActionPolicies)
    .values({
      userId,
      defaultMode: args.mode,
      integrationRules: DEFAULT_INTEGRATION_RULES,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        defaultMode: args.mode,
        rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
      },
    });
}
