import { notes, type Note } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const ownedByUser = (userId: string) => eq(notes.userId, userId);

export const fetchNotes = syncEntity(SYNC_MODEL.note, {
  versionQuery: (tx, userId) =>
    tx
      .select({ id: notes.id, rowVersion: notes.rowVersion })
      .from(notes)
      .where(ownedByUser(userId))
      .orderBy(asc(notes.id)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(notes)
      .where(
        and(
          ownedByUser(userId),
          inArray(
            notes.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(notes.id)),
  map: (n: Note) => n,
});
