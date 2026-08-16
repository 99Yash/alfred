import { notes, type Note } from "@alfred/db/schemas";
import { syncedNoteSchema, type SyncedNote } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toRequiredIso } from "./iso-date";

export const fetchNotes: EntityFetcher = async (tx, userId) => {
  const rows = await tx.select().from(notes).where(eq(notes.userId, userId)).orderBy(asc(notes.id));
  return rows.flatMap((n: Note) =>
    toEntityRow({
      slug: "NOTE",
      id: n.id,
      rowVersion: n.rowVersion,
      serialize: () => serializeNote(n),
    }),
  );
};

function serializeNote(n: {
  id: string;
  userId: string;
  text: string;
  rowVersion: number;
  createdAt: Date;
}): SyncedNote {
  return syncedNoteSchema.parse({
    id: n.id,
    userId: n.userId,
    text: n.text,
    createdAt: toRequiredIso(n.createdAt, "notes.createdAt"),
    rowVersion: n.rowVersion,
  });
}
