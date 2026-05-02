import { z } from "zod";
import type { WriteTransaction } from "replicache";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import type { SyncedNote } from "../types";

export const noteCreateArgsSchema = z.object({
  id: z.string().min(1).max(100),
  userId: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
  createdAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "createdAt must be a valid date-time string",
  }),
});
export type NoteCreateArgs = z.infer<typeof noteCreateArgsSchema>;

export async function noteCreateClient(tx: WriteTransaction, args: NoteCreateArgs): Promise<void> {
  const value: SyncedNote = { ...args, rowVersion: 0 };
  await tx.set(IDB_KEY.NOTE({ id: args.id }), normalizeToReadonlyJSON(value));
}
