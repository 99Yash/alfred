import { fetchFacts } from "../../src/sync/read/facts";
import { fetchNotes } from "../../src/sync/read/notes";
import type { EntityFetcher } from "../../src/sync/read/entity-row";
import { syncEntity } from "../../src/sync/read/sync-entity";

export const noteFetcher: EntityFetcher<"note"> = fetchNotes;

// @ts-expect-error — a `fact` reader cannot occupy the `note` registry slot
export const wrongFetcher: EntityFetcher<"note"> = fetchFacts;

export const incompleteNoteFetcher = syncEntity("note", {
  query: async () => [{ id: "note_1", userId: "user_1", text: "hi", rowVersion: 1 }],
  // @ts-expect-error — the `note` projection must include createdAt before Date serialization
  map: (row) => row,
});

export const runtimeValidatedNoteFetcher = syncEntity("note", {
  query: async () => [
    {
      id: "note_1",
      userId: "user_1",
      text: 42,
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      rowVersion: 1,
    },
  ],
  // Every schema key is present. The final selected-schema parse owns value validation.
  map: (row) => row,
});
