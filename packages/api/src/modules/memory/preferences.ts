import { db } from "@alfred/db";
import { userPreferences } from "@alfred/db/schemas";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type MemorySource, memorySourceSchema } from "./types";

export const setPreferenceArgsSchema = z.object({
  userId: z.string().min(1),
  key: z.string().min(1).max(200),
  value: z.unknown(),
  /** Defaults to `{ kind: 'user' }`. Agents that suggest a pref pass `{ kind: 'agent' }`. */
  source: memorySourceSchema.optional(),
});
export type SetPreferenceArgs = z.infer<typeof setPreferenceArgsSchema>;

export interface PreferenceRow {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  source: MemorySource;
  rowVersion: number;
}

function rowToPref(r: typeof userPreferences.$inferSelect): PreferenceRow {
  return {
    id: r.id,
    userId: r.userId,
    key: r.key,
    value: r.value,
    source: r.source as MemorySource,
    rowVersion: r.rowVersion,
  };
}

/**
 * Upsert a preference row. Bumps `row_version` on every set so
 * Replicache patches reflect changes.
 *
 * Why not append-only like `user_facts`: preferences are explicit user
 * settings (no provenance chain to preserve, no inferred-vs-confirmed
 * lifecycle). Last-write-wins is the right model.
 */
export async function setPreference(args: SetPreferenceArgs): Promise<PreferenceRow> {
  const parsed = setPreferenceArgsSchema.parse(args);
  const source: MemorySource = parsed.source ?? { kind: "user" };

  const [row] = await db()
    .insert(userPreferences)
    .values({ userId: parsed.userId, key: parsed.key, value: parsed.value, source })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: {
        value: parsed.value,
        source,
        rowVersion: sql`${userPreferences.rowVersion} + 1`,
      },
    })
    .returning();
  if (!row) throw new Error("[memory.preferences] setPreference returned no row");
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
  const result = await db()
    .delete(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .returning({ id: userPreferences.id });
  return result.length > 0;
}
