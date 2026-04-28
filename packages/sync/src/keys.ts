export const SYNC_ENTITIES = ['note'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export function noteKey(noteId: string): string {
  return `note/${noteId}`;
}

export const notePrefix = 'note/';

export type ParsedKey = { entity: 'note'; id: string };

export function parseKey(key: string): ParsedKey | null {
  const parts = key.split('/');
  if (parts.length !== 2) return null;
  const [entity, id] = parts;
  if (entity === 'note' && id) return { entity: 'note', id };
  return null;
}
