import { userPreferences, type UserPreference } from "@alfred/db/schemas";
import { syncedPreferenceSchema, type SyncedPreference } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

const serializePreference = defineSerializer<UserPreference, SyncedPreference>(
  syncedPreferenceSchema,
);

// Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
// so optimistic client writes can address rows without a lookup.
export const fetchPreferences = defineFetcher<UserPreference>({
  slug: "PREFERENCE",
  query: (tx, userId) =>
    tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .orderBy(asc(userPreferences.key)),
  idOf: (p) => p.key,
  versionOf: (p) => p.rowVersion,
  serialize: serializePreference,
});
