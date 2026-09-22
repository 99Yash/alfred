/**
 * `@alfred/assistant/knowledge/internal` — the single privileged tooling door
 * into the knowledge substrate's internals.
 *
 * The sanctioned knowledge contract (observe / recall / contextFor /
 * applyCorrection + genuinely cross-module helpers) flows out through the
 * curated barrel `./index`, published as `@alfred/assistant/knowledge`. A handful of
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
 *
 * The "tooling only" restriction is gate-enforced: an oxlint
 * `no-restricted-imports` rule in `.oxlintrc.json` forbids importing this subpath
 * from anywhere outside `apps/server/src/scripts/**`, so a route or worker reaching
 * for a write-capable internal here is a red `pnpm lint`, not a silent bypass.
 */
export { backfillTeamGraph } from "./team-graph";

// The ONE preview door for a mail contact's kind — shared by the dry-run
// preview (`team-graph.ts`) and the committed cleanup backfill, so "what is a
// person" cannot drift into a second copy (#1108, the #493 precedent). The
// classifier behind it stays inside the knowledge module: `entity-graph.ts` is
// its only importer.
export { previewContactKinds, type ContactKind } from "./entity-graph";

// The ONE definition of the `entities` unique-index clash a re-kind can hit —
// shared by the live writer and the committed cleanup backfill, so the "keep
// the current kind, never merge two contacts" policy has a single home.
export { reKindWouldCollide } from "./entity-graph";

export { parsePersonEntityMetadata } from "./entity-metadata";

export {
  gateDocumentFact,
  isServiceSender,
  isUninformativeRelationshipValue,
  type SelfIdentity,
} from "./fact-policy";

export { loadSelfIdentity } from "./self-identity";

export { embedMemoryChunk, findPendingEmbedChunks } from "./chunks";

export { isRejected } from "./rejected";
