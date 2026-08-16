import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "@alfred/assistant/action-policies";
import type { IntegrationRules } from "@alfred/contracts";
import { userActionPolicies } from "@alfred/db/schemas";
import type { PolicySetDefaultModeArgs, PolicySetIntegrationModeArgs } from "@alfred/sync";
import { sql } from "drizzle-orm";
import type { DbTx, ServerMutatorCtx } from "./mutator";

/**
 * Baseline rules for a row that doesn't exist yet (legacy user predating the
 * signup seed). Mirrors `ensureDefaultActionPolicyForUser` / `resolve.ts` so the
 * editor shows the same rules the resolver would apply. `system: autonomy` is
 * the SECOND line of defense only: `resolvePolicyMode` answers `"autonomy"` for
 * every `system.*` tool before it reads a row at all (ADR-0040 as amended), so
 * dropping it here cannot make a system tool gate.
 */
const DEFAULT_INTEGRATION_RULES: IntegrationRules = {
  system: { mode: "autonomy" },
};

export async function policySetIntegrationMode(
  tx: DbTx,
  args: PolicySetIntegrationModeArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const insertedRules: IntegrationRules = {
    ...DEFAULT_INTEGRATION_RULES,
    [args.slug]: { mode: args.mode },
  };

  await tx
    .insert(userActionPolicies)
    .values({
      userId: ctx.userId,
      defaultMode: "gated",
      integrationRules: insertedRules,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        // `::text` casts are load-bearing: the driver binds these as untyped
        // parameters and Postgres can't infer the type inside `jsonb_build_object`
        // (VARIADIC "any") or the `->` overload, so it raises "could not determine
        // data type of parameter". The casts pin each to text.
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

/**
 * Flip the user's global approval default. Inserts a baseline row (legacy
 * users predating the signup seed) or patches `default_mode` in place. The
 * push handler busts the dispatcher's policy cache after commit (see
 * `POLICY_BUST_MUTATORS`) so a gated→autonomy flip takes effect on the next
 * tool call without a restart.
 */
export async function policySetDefaultMode(
  tx: DbTx,
  args: PolicySetDefaultModeArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .insert(userActionPolicies)
    .values({
      userId: ctx.userId,
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
