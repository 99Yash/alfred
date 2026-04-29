import { notes } from "@alfred/db/schemas";
import type { NoteCreateArgs } from "@alfred/sync";

export interface ServerMutatorCtx {
  userId: string;
}

// Typed loosely so it accepts either the pool or a Drizzle tx handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

export const serverMutators = {
  async noteCreate(tx: DbTx, args: NoteCreateArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .insert(notes)
      .values({
        id: args.id,
        userId: ctx.userId,
        text: args.text,
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
  },
} as const;

export type ServerMutators = typeof serverMutators;
export type ServerMutatorName = keyof ServerMutators;
