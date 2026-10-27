import { isValidPage } from "@alfred/contracts";
import type { ChunkMetadata } from "@alfred/db/schemas";

export type { ChunkMetadata };

/** The only writer of `chunks.metadata`. An invalid page writes `{}`. */
export function chunkMetadata(page: number | null): ChunkMetadata {
  return isValidPage(page) ? { page } : {};
}
