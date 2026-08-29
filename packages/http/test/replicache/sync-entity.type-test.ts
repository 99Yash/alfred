import { fetchFacts } from "../../src/sync/read/facts";
import { fetchNotes } from "../../src/sync/read/notes";
import type { EntityFetcher } from "../../src/sync/read/entity-row";
import { syncEntity } from "../../src/sync/read/sync-entity";

export const noteFetcher: EntityFetcher<"NOTE"> = fetchNotes;

// @ts-expect-error — a FACT reader cannot occupy the NOTE registry slot
export const wrongFetcher: EntityFetcher<"NOTE"> = fetchFacts;

export const incompleteNoteFetcher = syncEntity("NOTE", {
  query: async () => [{ id: "note_1", userId: "user_1", text: "hi", rowVersion: 1 }],
  // @ts-expect-error — the NOTE projection must include createdAt before Date serialization
  map: (row) => row,
});
