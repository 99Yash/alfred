/**
 * `knowledge` — the single door to Alfred's knowledge substrate.
 *
 * Phase 4 consolidates observations, projections, facts, entities,
 * significance, standing instructions, and recall behind ONE module. This
 * slice (item 06) establishes the module and its OBSERVE side by folding in the
 * two edge-clean sources: the multi-source user-model write gate / read surface
 * and the chat-thread proposition extractor. Item 07 folds `memory` in and
 * APPENDS the `recall` / `contextFor` / `applyCorrection` surface below the
 * observe grouping — keep this index additive, never a runtime namespace.
 *
 * ── observe (multi-source user-model substrate, ADR-0067, #218) ──────────────
 * The ONLY sanctioned way to write to / read from the substrate:
 *
 *   - `insertObservation` — the HARD write gate (validated append + head upsert).
 *   - `ensureEntityNode` / `recordEntityIdentity` — the stable-layer write API.
 *   - `startProjectionRun` / `completeProjectionRun` / `failProjectionRun` /
 *     `writeProjectionCursor` / `activateProjectionVersion` — projection lifecycle,
 *     including the completed-only activation guard a FK can't express.
 *   - `userModelReader` — the active-projection read surface; consumers read this,
 *     never raw `WHERE projection_version = active`.
 *
 * ── observe (chat → memory extraction, chat-memory-capture-v1.md, #397) ──────
 * The cheap-model EXTRACTOR (`./extractor`) that distills a finished thread into
 * crisp, tagged propositions. No durable writes happen here — the observation
 * write path lands in #399; the idle end-of-thread TRIGGER lives next to the
 * compaction it drives in `conversations/idle-capture-queue.ts`.
 */
export { requireEntityIdNamespace } from "./namespace";
export {
  appendObservationFamilyMember,
  insertObservation,
  isObservationAppendConflict,
  type AppendObservationFamilyMemberResult,
  type InsertObservationResult,
} from "./observations";
export {
  reduceGmailDocument,
  type GmailDocumentForReduction,
  type GmailReductionIssue,
  type GmailReductionResult,
} from "./gmail-reducer";
export { projectGmailKindProfiles, type ProjectGmailKindProfilesResult } from "./gmail-kind-fold";
export {
  buildOrgAffiliationObservationInput,
  isOrgAffiliationObservationAppendConflict,
  recordOrgAffiliationOnConnect,
  recordOrgAffiliationOnCredentialUpsert,
  recordOrgAffiliationOnDisconnect,
  retryOnObservationChainConflict,
  type BuildOrgAffiliationResult,
  type BuildOrgAffiliationSkipReason,
  type CredentialForAffiliation,
  type OrgAffiliationStatus,
  type RecordOrgAffiliationOnCredentialUpsertResult,
  type RecordOrgAffiliationResult,
} from "./affiliation";
export { ensureEntityNode, recordEntityIdentity, EntityIdentityConflictError } from "./entities";
export {
  activateProjectionVersion,
  completeProjectionRun,
  failProjectionRun,
  startProjectionRun,
  writeProjectionCursor,
} from "./projection";
export { userModelReader, type ActiveEntityProfile } from "./reader";
export { refoldActiveGmailKindProjection } from "./refold";
export * from "./extractor";

/**
 * ── recall · contextFor · applyCorrection (folded from `memory`, item 07) ────
 *
 * Item 07 folded the former `memory` module in, completing the knowledge domain
 * behind ONE interface. The groupings below are DOCUMENTARY (Tier 3) — nothing
 * at compile time forbids a "recall" export from writing. Every symbol
 * re-exported here is byte-identical to its former `../memory/*` home.
 *
 *   - recall           — `recallActiveByKey` / `recallLatestByKey` /
 *                        `listFactsByStatus` / `getSupersessionChain` (facts),
 *                        `recallMemory` + `RecallMemoryHit` (chunks).
 *   - contextFor       — `readUserContext` + `UserContext` (user-context).
 *   - applyCorrection  — `proposeFact` / `confirmFact` / `supersedeFact` /
 *                        `rejectFact` / `editFact` (facts).
 *
 * Item 15 CURATED this barrel: each behavior-bearing internal file is now an
 * explicit `export { … }` of only the symbols a sibling-`api` module imports
 * through `../knowledge`, not a wholesale `export *`. Six whole files
 * (self-identity, entity-graph, team-graph, style-profiles, rejected,
 * extraction) left the barrel entirely — their symbols stay `export`ed from
 * their own file for intra-`knowledge` direct import, so nothing inside the
 * module breaks, but no new sibling caller can reach them through `../knowledge`.
 * Item 16 then closed the twin leak: `backend.ts` re-exports this curated
 * barrel with a single `export * from "./modules/knowledge"` instead of the old
 * by-path `export *` block, so the only door to a privileged tooling internal is
 * the explicit `@alfred/api/modules/knowledge/internal` subpath (nine named
 * re-exports for `apps/server` backfills/smokes). Both boundaries are now Tier-2:
 * a new `packages/api/src/modules/*` file cannot reach a dropped internal through
 * `../knowledge`, and no unlisted knowledge internal is reachable through
 * `@alfred/api/backend` either.
 *
 * `./types` stays `export *` — pure enums / schemas / contract re-exports, no
 * behavior-bearing symbol, so curating it buys no encapsulation.
 */
export * from "./types";

// recall + applyCorrection (facts) — both sanctioned groupings share this file.
export {
  // recall
  recallActiveByKey,
  recallLatestByKey,
  listFactsByStatus,
  getSupersessionChain,
  // applyCorrection
  proposeFact,
  confirmFact,
  supersedeFact,
  rejectFact,
  editFact,
  proposeFactArgsSchema,
  type FactRow,
  type ProposeFactArgs,
} from "./facts";
// recall (chunks) + the cold-start write door.
export { recallMemory, writeMemoryChunk, type RecallMemoryHit } from "./chunks";
// contextFor.
export { readUserContext, type UserContext } from "./user-context";

// Cross-module helpers reached through this barrel by a non-test sibling-`api`
// module (replicache / triage / briefing / tools / todos). Not part of the
// sanctioned observe/recall/contextFor/applyCorrection set, but genuinely
// cross-module — curated here rather than left as a wholesale `export *`.
export { valueSignature } from "./signature";
export { isSingleValuedKey, isUninformativeRelationshipFact } from "./fact-policy";
export {
  getSenderSignificance,
  getSenderSignificanceBatch,
  findPersonMetadataByAddress,
  type SenderSignificance,
} from "./significance";
export { type Significance } from "./entity-metadata";
export {
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  listActiveSuppressionInstructions,
  findSenderSuppression,
  findActiveSenderSuppression,
  normalizeSenderEmail,
  // NOTE: the pure `rememberSenderSuppression` write is a public door — prefer
  // the `tools` suppression coordinator, which also dismisses the matching todos.
  rememberSenderSuppression,
  type RememberSenderSuppressionArgs,
  type RememberSenderSuppressionResult,
  type SenderSuppressionMatch,
} from "./standing-instructions";

// Worker lifecycle — names preserved so `runtime.ts` re-exports resolve unchanged.
export { startMemoryWorker, stopMemoryWorker, closeMemoryQueue } from "./queue";
export { scheduleRepeatableMemoryJobs } from "./repeatable";

// Product recipe owned by the knowledge module; the composition root builds it
// with the injected Gmail sender adapter (ADR-0089) and registers the result.
export { buildMemoryExtractionWorkflow } from "./memory-extraction";

/**
 * ── memory acquisition sub-areas folded into knowledge (item 07) ─────────────
 *
 * `cold-start/` and `drift-audit/` were standalone modules; both are knowledge
 * activities (turning web findings into user_facts/memory chunks; auditing the
 * user-model substrate for drift) so they fold in here. Their whole former index
 * surface is re-exported wholesale so `@alfred/api/backend` — which used to carry
 * a `export *` from each module directly — surfaces the exact same symbols now
 * through the single `knowledge` barrel. `web-search` (the grounded-Gemini live
 * search) moves in alongside its now-primary consumer, cold-start research.
 */
export * from "./cold-start";
export * from "./drift-audit";
export { runWebSearch, type WebSearchArgs, type WebSearchResult } from "./web-search";
