import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { syncedActionPolicySchema, type SyncedActionPolicy } from "@alfred/sync";
import { eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";

// The per-integration policy editor (m13 Phase 8c). One row per user,
// synced as a single entity keyed by `userId`; the web derives each
// integration's mode from `integration_rules[slug] ?? default_mode`.
export const fetchActionPolicies: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(userActionPolicies)
    .where(eq(userActionPolicies.userId, userId));
  return rows.flatMap((p: UserActionPolicy) =>
    toEntityRow({
      slug: "ACTION_POLICY",
      id: p.userId,
      rowVersion: p.rowVersion,
      serialize: () => serializeActionPolicy(p),
    }),
  );
};

function serializeActionPolicy(p: UserActionPolicy): SyncedActionPolicy {
  return syncedActionPolicySchema.parse({
    userId: p.userId,
    defaultMode: p.defaultMode,
    integrationRules: p.integrationRules,
    approvalNotifyDelayMs: p.approvalNotifyDelayMs,
    rowVersion: p.rowVersion,
  });
}
