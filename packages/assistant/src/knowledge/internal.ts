/**
 * `@alfred/assistant/knowledge/internal`: the tooling door for `apps/server`
 * scripts. Named exports only, so a new internal cannot leak through.
 * `.oxlintrc.json` forbids importing it outside `apps/server/src/scripts/**`.
 */
export { backfillTeamGraph } from "./team-graph";

// Row-keyed, for a backfill that already holds the rows. The address-keyed
// `previewContactKinds` is not published, so scripts cannot pick the wrong door.
export { previewStoredContactKinds, type ContactKind } from "./entity-graph";

// The one definition of the re-kind clash with the `entities` unique index.
export { reKindWouldCollide } from "./entity-graph";

export {
  gateDocumentFact,
  isServiceSender,
  isUninformativeRelationshipValue,
  type SelfIdentity,
} from "./fact-policy";

export { loadSelfIdentity } from "./self-identity";

export { embedMemoryChunk, findPendingEmbedChunks } from "./chunks";

export { isRejected } from "./rejected";
