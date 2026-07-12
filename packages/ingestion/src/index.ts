// Shared chunker, embedder, dedup, and vector-write helpers.
// Real Voyage embeddings + pgvector cosine search wired in m7b.
export { chunkText, estimateTokens } from "./chunker";
export type { Chunk, ChunkerOptions } from "./chunker";
export {
  embedDocument,
  findUnembeddedDocumentIds,
  recordDocumentEmbedFailure,
} from "./embed-document";
export type { EmbedDocumentArgs, EmbedDocumentResult } from "./embed-document";
export { semanticSearch } from "./search";
export type { SearchArgs, SearchHit } from "./search";
