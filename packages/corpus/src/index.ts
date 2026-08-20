// @alfred/corpus — document indexing + semantic retrieval over the chunk corpus.
// The chunker and the Voyage embed machinery are package-internal; callers see
// the corpus verbs (indexDocument / retryPending / search) plus the two embed
// primitives the DB-backed poison-pill test and the poll smoke assert against.
export {
  indexDocument,
  findUnembeddedDocumentIds,
  recordDocumentEmbedFailure,
} from "./embed-document";
export { chunkPages, chunkText, estimateTokens } from "./chunker";
export type { Chunk, ChunkerOptions, PageInput } from "./chunker";
export type { IndexDocumentArgs, IndexDocumentResult } from "./embed-document";
export { retryPending } from "./retry-pending";
export type { RetryPendingArgs, RetryPendingResult } from "./retry-pending";
export { search } from "./search";
export type { SearchArgs, SearchHit } from "./search";
