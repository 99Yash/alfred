import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import { memorySourceSchema, preferenceValueSchema } from "../schemas";
import type { SyncedPreference } from "../schemas";

// Preference mutators (ADR-0012). Last write wins.

export const prefSetArgsSchema = z.object({
  key: z.string().min(1).max(200),
  value: preferenceValueSchema,
  /** Defaults to `{ kind: 'user' }`. */
  source: memorySourceSchema.optional(),
});

export type PrefSetArgs = z.infer<typeof prefSetArgsSchema>;

export const prefDeleteArgsSchema = z.object({
  key: z.string().min(1).max(200),
});

export type PrefDeleteArgs = z.infer<typeof prefDeleteArgsSchema>;

export async function prefSetClient(tx: WriteTransaction, args: PrefSetArgs): Promise<void> {
  const prev = await SYNC_MODEL.pref.get(tx, { key: args.key });

  const replacement: SyncedPreference = {
    key: args.key,
    userId: prev?.userId ?? "",
    value: args.value,
    source: args.source ?? prev?.source ?? { kind: "user" },
    rowVersion: (prev?.rowVersion ?? -1) + 1,
  };

  await SYNC_MODEL.pref.put(tx, replacement);
}

export async function prefDeleteClient(tx: WriteTransaction, args: PrefDeleteArgs): Promise<void> {
  await SYNC_MODEL.pref.del(tx, { key: args.key });
}
