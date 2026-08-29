import { userPreferences, type UserPreference } from "@alfred/db/schemas";
import { asc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

// Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
// so optimistic client writes can address rows without a lookup.
export const fetchPreferences = syncEntity("pref", {
  query: (tx, userId) =>
    tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .orderBy(asc(userPreferences.key)),
  map: (p: UserPreference) => ({
    key: p.key,
    userId: p.userId,
    value: p.value,
    source: p.source,
    rowVersion: p.rowVersion,
  }),
});
