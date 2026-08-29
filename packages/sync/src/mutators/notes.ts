import { z } from "zod";
import type { WriteTransaction } from "replicache";
import { normalizeToReadonlyJSON, SYNC_MODEL } from "../sync-model";
import { isoDateTimeStringSchema } from "../schemas";
import type { SyncedNote } from "../types";

export const noteCreateArgsSchema = z.object({
  id: z.string().min(1).max(100),
  userId: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
  createdAt: isoDateTimeStringSchema,
});
export type NoteCreateArgs = z.infer<typeof noteCreateArgsSchema>;

export async function noteCreateClient(tx: WriteTransaction, args: NoteCreateArgs): Promise<void> {
  const value: SyncedNote = { ...args, rowVersion: 0 };
  await tx.set(SYNC_MODEL.note.storageKeyForId(args.id), normalizeToReadonlyJSON(value));
}
