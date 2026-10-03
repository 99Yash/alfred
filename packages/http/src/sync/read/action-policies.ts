import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const ownedByUser = (userId: string) => eq(userActionPolicies.userId, userId);

// The per-integration policy editor (m13 Phase 8c). One row per user,
// synced as a single entity keyed by `userId`; the web derives each
// integration's mode from `integration_rules[slug] ?? default_mode`.
export const fetchActionPolicies = syncEntity(SYNC_MODEL.actionpolicy, {
  versionQuery: (tx, userId) =>
    tx
      .select({ userId: userActionPolicies.userId, rowVersion: userActionPolicies.rowVersion })
      .from(userActionPolicies)
      .where(ownedByUser(userId)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(userActionPolicies)
      .where(
        and(
          ownedByUser(userId),
          inArray(
            userActionPolicies.userId,
            changed.map((v) => v.userId),
          ),
        ),
      ),
  map: (p: UserActionPolicy) => p,
});
