import { notes, type Note } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

export const fetchNotes = syncEntity(SYNC_MODEL.note, {
  query: (tx, userId) =>
    tx.select().from(notes).where(eq(notes.userId, userId)).orderBy(asc(notes.id)),
  map: (n: Note) => n,
});
