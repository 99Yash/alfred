// Document indexing and semantic search over chunks.
export {
  indexDocument,
  findUnembeddedDocumentIds,
  recordDocumentEmbedFailure,
} from "./embed-document";

export { chunkMetadata, extractPageFromMetadata } from "./chunk-metadata";

export type { ChunkMetadata } from "./chunk-metadata";

export { sha256 } from "./hash";

export { chunkPages, chunkText, estimateTokens } from "./chunker";

export type { Chunk, ChunkerOptions, PageInput } from "./chunker";

export type { IndexDocumentArgs, IndexDocumentResult } from "./embed-document";

export { retryPending } from "./retry-pending";

export type { RetryPendingArgs, RetryPendingResult } from "./retry-pending";

export { search, toModelFacingHit } from "./search";

export type { ModelFacingHit, RecordIdentity, SearchArgs, SearchHit } from "./search";
