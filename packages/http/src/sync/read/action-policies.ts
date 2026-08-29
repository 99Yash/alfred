import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { syncedActionPolicySchema, type SyncedActionPolicy } from "@alfred/sync";
import { eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

// The per-integration policy editor (m13 Phase 8c). One row per user,
// synced as a single entity keyed by `userId`; the web derives each
// integration's mode from `integration_rules[slug] ?? default_mode`.
const serializeActionPolicy = defineSerializer<UserActionPolicy, SyncedActionPolicy>(
  syncedActionPolicySchema,
);

export const fetchActionPolicies = defineFetcher<UserActionPolicy>({
  slug: "ACTION_POLICY",
  query: (tx, userId) =>
    tx.select().from(userActionPolicies).where(eq(userActionPolicies.userId, userId)),
  idOf: (p) => p.userId,
  versionOf: (p) => p.rowVersion,
  serialize: serializeActionPolicy,
});
