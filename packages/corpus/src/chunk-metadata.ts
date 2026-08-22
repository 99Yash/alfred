import { isRecord, isValidPage } from "@alfred/contracts";
import type { ChunkMetadata } from "@alfred/db/schemas";

export type { ChunkMetadata };

/**
 * Build the metadata row for one chunk from its proven page anchor — the
 * single write door for `chunks.metadata`. The same validity rule
 * (`isValidPage`) gates both doors, so an invalid anchor writes an empty
 * record rather than an unproven page.
 */
export function chunkMetadata(page: number | null): ChunkMetadata {
  return isValidPage(page) ? { page } : {};
}

/**
 * Read the proven page anchor off stored chunk metadata. Shared by the embed
 * skip path and `search`, so every reader of `chunks.metadata.page` applies
 * the same validity rule (`isValidPage`) and a hit can never claim an
 * unproven page (ADR-0091). The column carries a `$type`, but jsonb contents
 * are not guaranteed by the database layer, so this gate stays the last check
 * between a stored row and a citation.
 */
export function extractPageFromMetadata(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const page = raw.page;
  return isValidPage(page) ? page : null;
}
