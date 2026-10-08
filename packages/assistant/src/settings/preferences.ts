import { db, type DbRoot, type DbTransaction } from "@alfred/db";
import {
  userPreferenceInsertSchema,
  userPreferences,
  type NewUserPreference,
  type UserPreference,
} from "@alfred/db/schemas";
import {
  type MemorySource,
  memorySourceSchema,
  parseMemorySourceOrDefault,
} from "@alfred/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const setPreferenceArgsSchema = userPreferenceInsertSchema
  .pick({ userId: true, key: true, value: true, source: true })
  .extend({
    userId: z.string().min(1),
    key: z.string().min(1).max(200),
    /** Defaults to `{ kind: 'user' }`. */
    source: memorySourceSchema.optional(),
  }) satisfies z.ZodType<Pick<NewUserPreference, "userId" | "key" | "value" | "source">>;

export type SetPreferenceArgs = z.infer<typeof setPreferenceArgsSchema>;

/** The row with `source` parsed and without lifecycle dates. */
export type PreferenceRow = Omit<UserPreference, "source" | "createdAt" | "updatedAt"> & {
  source: MemorySource;
};

function rowToPref(r: UserPreference): PreferenceRow {
  return {
    ...r,
    source: parseMemorySourceOrDefault(r.source, { kind: "user" }, `user_preferences:${r.id}`),
  };
}

/** `db()` or a Replicache push `tx`. */
export type PreferenceWriteExecutor = DbRoot | DbTransaction;

/**
 * The only `user_preferences` upsert. Returns the builder un-awaited, so the caller may add `.returning()`.
 * Last write wins: unlike `user_facts`, a preference has no provenance to keep.
 */
export function upsertPreference(exec: PreferenceWriteExecutor, args: SetPreferenceArgs) {
  const source: MemorySource = args.source ?? { kind: "user" };

  return exec
    .insert(userPreferences)
    .values({ userId: args.userId, key: args.key, value: args.value, source })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: {
        value: args.value,
        source,
        rowVersion: sql`${userPreferences.rowVersion} + 1`,
      },
    });
}

/** The only `user_preferences` delete. Returns the builder un-awaited. */
export function deletePreferenceRow(exec: PreferenceWriteExecutor, userId: string, key: string) {
  return exec
    .delete(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)));
}

export async function setPreference(args: SetPreferenceArgs): Promise<PreferenceRow> {
  const parsed = setPreferenceArgsSchema.parse(args);
  const [row] = await upsertPreference(db(), parsed).returning();

  if (!row) throw new Error("[settings.preferences] setPreference returned no row");

  return rowToPref(row);
}

export async function getPreference(userId: string, key: string): Promise<PreferenceRow | null> {
  const [row] = await db()
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1);

  return row ? rowToPref(row) : null;
}

export async function getPreferences(userId: string): Promise<PreferenceRow[]> {
  const rows = await db()
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .orderBy(asc(userPreferences.key));

  return rows.map(rowToPref);
}

/** Revert to the default. */
export async function deletePreference(userId: string, key: string): Promise<boolean> {
  const result = await deletePreferenceRow(db(), userId, key).returning({
    id: userPreferences.id,
  });

  return result.length > 0;
}
