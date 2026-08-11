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
    /** Defaults to `{ kind: 'user' }`. Agents that suggest a pref pass `{ kind: 'agent' }`. */
    source: memorySourceSchema.optional(),
  }) satisfies z.ZodType<Pick<NewUserPreference, "userId" | "key" | "value" | "source">>;
export type SetPreferenceArgs = z.infer<typeof setPreferenceArgsSchema>;

/**
 * Like the DB row, but with `source` narrowed to its parsed shape. Every other
 * column tracks `UserPreference` ($inferSelect) automatically; lifecycle dates
 * are intentionally excluded. Only `source`, which `rowToPref` zod-parses, is
 * restated.
 */
export type PreferenceRow = Omit<UserPreference, "source" | "createdAt" | "updatedAt"> & {
  source: MemorySource;
};

function rowToPref(r: UserPreference): PreferenceRow {
  return {
    ...r,
    source: parseMemorySourceOrDefault(r.source, { kind: "user" }, `user_preferences:${r.id}`),
  };
}

/**
 * A pooled handle (`db()`) OR a Replicache push `tx` — both satisfy the
 * `user_preferences` write. The same `DbRoot | DbTransaction` executor seam the
 * repo's other push-transaction-aware writers take, so a mutator and a plain
 * service call reach the row through one function.
 */
export type PreferenceWriteExecutor = DbRoot | DbTransaction;

/**
 * THE `user_preferences` upsert — the sole author of the value map, conflict
 * target, update set, and default-`source` rule. Runs against any executor: the
 * pooled `db()` handle (the `setPreference` gateway) or a Replicache push `tx`
 * (the `prefSet` mutator, so the write commits inside the push transaction).
 *
 * Returns the builder **un-awaited** so each caller picks its own tail:
 * `setPreference` appends `.returning()` for its atomic row; the `prefSet`
 * mutator awaits it bare (no `RETURNING`, byte-identical to its former inline).
 *
 * Why not append-only like `user_facts`: preferences are explicit user
 * settings (no provenance chain to preserve, no inferred-vs-confirmed
 * lifecycle). Last-write-wins is the right model.
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

/**
 * THE `user_preferences` delete — the sole author of the `(userId, key)` match
 * predicate. Returns the builder un-awaited (same tail-choice contract as
 * {@link upsertPreference}): `deletePreference` appends `.returning({ id })`;
 * the `prefDelete` mutator awaits it bare.
 */
export function deletePreferenceRow(exec: PreferenceWriteExecutor, userId: string, key: string) {
  return exec
    .delete(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)));
}

/** Upsert a preference through the pooled handle; returns the parsed row. */
export async function setPreference(args: SetPreferenceArgs): Promise<PreferenceRow> {
  const parsed = setPreferenceArgsSchema.parse(args);
  const [row] = await upsertPreference(db(), parsed).returning();
  if (!row) throw new Error("[settings.preferences] setPreference returned no row");
  return rowToPref(row);
}

/** Single key, or null if unset. */
export async function getPreference(userId: string, key: string): Promise<PreferenceRow | null> {
  const [row] = await db()
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1);
  return row ? rowToPref(row) : null;
}

/** All preferences for a user — for the settings page + agent system-prompt injection. */
export async function getPreferences(userId: string): Promise<PreferenceRow[]> {
  const rows = await db()
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .orderBy(asc(userPreferences.key));
  return rows.map(rowToPref);
}

/** Delete a preference (revert to default). */
export async function deletePreference(userId: string, key: string): Promise<boolean> {
  const result = await deletePreferenceRow(db(), userId, key).returning({
    id: userPreferences.id,
  });
  return result.length > 0;
}
