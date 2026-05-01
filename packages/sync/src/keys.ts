export const SYNC_ENTITIES = ["note", "fact"] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export function noteKey(noteId: string): string {
  return `note/${noteId}`;
}

export const notePrefix = "note/";

export function factKey(factId: string): string {
  return `fact/${factId}`;
}

export const factPrefix = "fact/";

export type ParsedKey = { entity: "note"; id: string } | { entity: "fact"; id: string };

export function parseKey(key: string): ParsedKey | null {
  const parts = key.split("/");
  if (parts.length !== 2) return null;
  const [entity, id] = parts;
  if (!id) return null;
  if (entity === "note") return { entity: "note", id };
  if (entity === "fact") return { entity: "fact", id };
  return null;
}
