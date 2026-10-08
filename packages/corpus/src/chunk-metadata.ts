import { isRecord, isValidPage } from "@alfred/contracts";
import type { ChunkMetadata } from "@alfred/db/schemas";

export type { ChunkMetadata };

/** The only writer of `chunks.metadata`. An invalid page writes `{}`. */
export function chunkMetadata(page: number | null): ChunkMetadata {
  return isValidPage(page) ? { page } : {};
}

/** Read the page from stored chunk metadata. jsonb is not checked by the DB, so validate here (ADR-0091). */
export function extractPageFromMetadata(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const page = raw.page;

  return isValidPage(page) ? page : null;
}
