import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "@alfred/assistant/action-policies";
import { withToolOverride, type IntegrationRules } from "@alfred/contracts";
import { userActionPolicies } from "@alfred/db/schemas";
import type {
  PolicySetDefaultModeArgs,
  PolicySetIntegrationModeArgs,
  PolicySetToolModeArgs,
} from "@alfred/sync";
import { eq, sql } from "drizzle-orm";
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

/**
 * Set or clear one tool's override. Read-modify-write under a row lock, so the drop rule in
 * `withToolOverride` sees the same integration mode the client computed against.
 */
export async function policySetToolMode(
  tx: DbTransaction,
  args: PolicySetToolModeArgs,
  userId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      defaultMode: userActionPolicies.defaultMode,
      integrationRules: userActionPolicies.integrationRules,
    })
    .from(userActionPolicies)
    .where(eq(userActionPolicies.userId, userId))
    .for("update")
    .limit(1);

  const defaultMode = row?.defaultMode ?? "gated";

  const integrationRules = withToolOverride(
    row?.integrationRules ?? DEFAULT_INTEGRATION_RULES,
    args.toolName,
    args.mode,
    defaultMode,
  );

  await tx
    .insert(userActionPolicies)
    .values({
      userId,
      defaultMode,
      integrationRules,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        integrationRules,
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
