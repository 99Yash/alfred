import { userPreferences, type UserPreference } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const ownedByUser = (userId: string) => eq(userPreferences.userId, userId);

// Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
// so optimistic client writes can address rows without a lookup.
export const fetchPreferences = syncEntity(SYNC_MODEL.pref, {
  versionQuery: (tx, userId) =>
    tx
      .select({ key: userPreferences.key, rowVersion: userPreferences.rowVersion })
      .from(userPreferences)
      .where(ownedByUser(userId))
      .orderBy(asc(userPreferences.key)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(userPreferences)
      .where(
        and(
          ownedByUser(userId),
          inArray(
            userPreferences.key,
            changed.map((v) => v.key),
          ),
        ),
      )
      .orderBy(asc(userPreferences.key)),
  map: (p: UserPreference) => ({
    key: p.key,
    userId: p.userId,
    value: p.value,
    source: p.source,
    rowVersion: p.rowVersion,
  }),
});
