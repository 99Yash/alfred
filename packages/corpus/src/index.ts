// Document indexing and semantic search over chunks.
export {
  indexDocument,
  findUnembeddedDocumentIds,
  recordDocumentEmbedFailure,
} from "./embed-document";

export { chunkMetadata } from "./chunk-metadata";

export type { ChunkMetadata } from "./chunk-metadata";

export { chunkPages, chunkText, estimateTokens } from "./chunker";

export type { Chunk, ChunkerOptions, PageInput } from "./chunker";

export type { IndexDocumentArgs, IndexDocumentResult } from "./embed-document";

export { retryPending } from "./retry-pending";

export type { RetryPendingArgs, RetryPendingResult } from "./retry-pending";

export { corpus } from "./search";

export type { Corpus, ModelFacingHit } from "./search";
