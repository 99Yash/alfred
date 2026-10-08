import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const ownedByUser = (userId: string) => eq(userActionPolicies.userId, userId);

// One row per user, keyed by `userId`. The web resolves `integration_rules[slug] ?? default_mode`.
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
