/**
 * `@alfred/api/modules/knowledge/internal` — the single privileged tooling door
 * into the knowledge substrate's internals.
 *
 * The sanctioned knowledge contract (observe / recall / contextFor /
 * applyCorrection + genuinely cross-module helpers) flows out through the
 * curated barrel `./index` and onto `@alfred/api/backend`. A handful of
 * `apps/server` operational scripts (backfills / smokes) legitimately reach
 * PAST that contract to poke internal projection / policy / significance
 * helpers — a privileged tooling surface, not the general public one.
 *
 * This file is that surface: an EXPLICIT, curated, named re-export of exactly
 * the internals a committed backfill or smoke needs. It is `export { … }`, never
 * `export *`, so a new internal added to one of the owning files cannot leak
 * through here — a future tooling symbol needs its own line added below. Honors
 * ADR-0089 ("one supported interface per module"): one named door, not a
 * wildcard leak of five internal files.
 */
export { backfillTeamGraph } from "./team-graph";
export {
  gateDocumentFact,
  isServiceSender,
  isUninformativeRelationshipValue,
  type SelfIdentity,
} from "./fact-policy";
export { loadSelfIdentity } from "./self-identity";
export { embedMemoryChunk, findPendingEmbedChunks } from "./chunks";
export { isRejected } from "./rejected";
