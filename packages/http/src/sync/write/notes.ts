import { notes } from "@alfred/db/schemas";
import type { NoteCreateArgs } from "@alfred/sync";
import type { DbTransaction } from "@alfred/db";

export async function noteCreate(
  tx: DbTransaction,
  args: NoteCreateArgs,
  userId: string,
): Promise<void> {
  await tx
    .insert(notes)
    .values({
      id: args.id,
      userId,
      text: args.text,
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}
