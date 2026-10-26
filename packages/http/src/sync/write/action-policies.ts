import { defaultActionPolicy } from "@alfred/assistant/action-policies";
import { withToolOverride } from "@alfred/contracts";
import { userActionPolicies } from "@alfred/db/schemas";
import type {
  PolicySetDefaultModeArgs,
  PolicySetIntegrationModeArgs,
  PolicySetToolModeArgs,
} from "@alfred/sync";
import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";

export async function policySetIntegrationMode(
  tx: DbTransaction,
  args: PolicySetIntegrationModeArgs,
  userId: string,
): Promise<void> {
  const base = defaultActionPolicy(userId);

  await tx
    .insert(userActionPolicies)
    .values({
      ...base,
      integrationRules: { ...base.integrationRules, [args.slug]: { mode: args.mode } },
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

  const base = defaultActionPolicy(userId);

  const defaultMode = row?.defaultMode ?? base.defaultMode;

  const integrationRules = withToolOverride(
    row?.integrationRules ?? base.integrationRules,
    args.toolName,
    args.mode,
    defaultMode,
  );

  await tx
    .insert(userActionPolicies)
    // The computed values go last, so the defaults never overwrite them.
    .values({ ...base, defaultMode, integrationRules })
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
    .values({ ...defaultActionPolicy(userId), defaultMode: args.mode })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        defaultMode: args.mode,
        rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
      },
    });
}
