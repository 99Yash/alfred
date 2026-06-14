import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { memorySourceSchema, preferenceValueSchema, syncedPreferenceSchema } from "../schemas";
import type { SyncedPreference } from "../types";
import { readSyncedValue } from "./read";

/**
 * Client-side mutators for `user_preferences` (ADR-0012).
 *
 * Preferences are last-write-wins — there's no provenance chain or
 * proposed/confirmed lifecycle to preserve, so the optimistic patch is a
 * single `tx.set` keyed on the user-facing pref key. The next server
 * pull rebases over the canonical row.
 */

export const prefSetArgsSchema = z.object({
  key: z.string().min(1).max(200),
  value: preferenceValueSchema,
  /** Optional provenance override; defaults to `{ kind: 'user' }` server-side. */
  source: memorySourceSchema.optional(),
});
export type PrefSetArgs = z.infer<typeof prefSetArgsSchema>;

export const prefDeleteArgsSchema = z.object({
  key: z.string().min(1).max(200),
});
export type PrefDeleteArgs = z.infer<typeof prefDeleteArgsSchema>;

/**
 * Optimistic upsert. The client doesn't know the server-side row id,
 * but the IDB store is keyed on `pref/{key}` so we don't need it.
 * Server-side write bumps `row_version`; the next pull will overwrite
 * with the canonical version.
 */
export async function prefSetClient(tx: WriteTransaction, args: PrefSetArgs): Promise<void> {
  const idbKey = IDB_KEY.PREFERENCE({ id: args.key });
  const prev = await readSyncedValue(tx, idbKey, syncedPreferenceSchema);
  const replacement: SyncedPreference = {
    key: args.key,
    userId: prev?.userId ?? "",
    value: args.value,
    source: args.source ?? prev?.source ?? { kind: "user" },
    rowVersion: (prev?.rowVersion ?? -1) + 1,
  };
  await tx.set(idbKey, normalizeToReadonlyJSON(replacement));
}

/** Optimistic delete. Server removes the row; next pull confirms. */
export async function prefDeleteClient(tx: WriteTransaction, args: PrefDeleteArgs): Promise<void> {
  const idbKey = IDB_KEY.PREFERENCE({ id: args.key });
  const exists = await tx.has(idbKey);
  if (!exists) return;
  await tx.del(idbKey);
}
