import { userPreferences, type UserPreference } from "@alfred/db/schemas";
import { memorySourceSchema, syncedPreferenceSchema, type SyncedPreference } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";

// Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
// so optimistic client writes can address rows without a lookup.
export const fetchPreferences: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .orderBy(asc(userPreferences.key));
  return rows.flatMap((p: UserPreference) =>
    toEntityRow({
      slug: "PREFERENCE",
      id: p.key,
      rowVersion: p.rowVersion,
      serialize: () => serializePreference(p),
    }),
  );
};

function serializePreference(p: UserPreference): SyncedPreference {
  return syncedPreferenceSchema.parse({
    key: p.key,
    userId: p.userId,
    value: p.value,
    source: memorySourceSchema.parse(p.source),
    rowVersion: p.rowVersion,
  });
}
