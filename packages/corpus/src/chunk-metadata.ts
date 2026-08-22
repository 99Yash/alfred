import { isRecord, isValidPage } from "@alfred/contracts";

/**
 * The shape `@alfred/corpus` writes into `chunks.metadata`. The embed pipeline
 * is the only writer, so this type names every key the column can carry. The
 * column itself stays `unknown` in `@alfred/db` — jsonb contents are not
 * guaranteed by the database layer, and rows written before a key existed
 * predate the type — so readers narrow through {@link extractPageFromMetadata}
 * and writers build through {@link chunkMetadata}.
 */
export interface ChunkMetadata {
  /**
   * The 1-indexed PDF page the extractor proved this chunk sits on. Absent
   * when the parent document carries no page structure (ADR-0091).
   */
  page?: number;
}

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
 * unproven page (ADR-0091).
 */
export function extractPageFromMetadata(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const page = raw.page;
  return isValidPage(page) ? page : null;
}
