import { notes, type Note } from "@alfred/db/schemas";
import { syncedNoteSchema, type SyncedNote } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

const serializeNote = defineSerializer<Note, SyncedNote>(syncedNoteSchema);

export const fetchNotes = defineFetcher<Note>({
  slug: "NOTE",
  query: (tx, userId) =>
    tx.select().from(notes).where(eq(notes.userId, userId)).orderBy(asc(notes.id)),
  idOf: (n) => n.id,
  versionOf: (n) => n.rowVersion,
  serialize: serializeNote,
});
