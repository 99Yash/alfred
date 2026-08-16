import { notes } from "@alfred/db/schemas";
import type { NoteCreateArgs } from "@alfred/sync";
import type { DbTx, ServerMutatorCtx } from "./mutator";

export async function noteCreate(
  tx: DbTx,
  args: NoteCreateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .insert(notes)
    .values({
      id: args.id,
      userId: ctx.userId,
      text: args.text,
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}
