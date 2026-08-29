import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

// The per-integration policy editor (m13 Phase 8c). One row per user,
// synced as a single entity keyed by `userId`; the web derives each
// integration's mode from `integration_rules[slug] ?? default_mode`.
export const fetchActionPolicies = syncEntity("ACTION_POLICY", {
  query: (tx, userId) =>
    tx.select().from(userActionPolicies).where(eq(userActionPolicies.userId, userId)),
  map: (p: UserActionPolicy) => p,
});
