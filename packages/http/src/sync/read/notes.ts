import { notes, type Note } from "@alfred/db/schemas";
import { asc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

export const fetchNotes = syncEntity("note", {
  query: (tx, userId) =>
    tx.select().from(notes).where(eq(notes.userId, userId)).orderBy(asc(notes.id)),
  map: (n: Note) => n,
});
