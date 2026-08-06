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
 * Item 07 folds the former `memory` module in, completing the knowledge domain
 * behind ONE interface. The groupings below are DOCUMENTARY (Tier 3) — nothing
 * at compile time forbids a "recall" export from writing. The fold is a
 * behavior-neutral relocation: every symbol re-exported here is byte-identical
 * to its former `../memory/*` home.
 *
 *   - recall           — `recallActiveByKey` / `recallLatestByKey` /
 *                        `listFactsByStatus` / `getSupersessionChain` (facts),
 *                        `recallMemory` + `RecallMemoryHit` (chunks).
 *   - contextFor       — `readUserContext` + `UserContext` (user-context).
 *   - applyCorrection  — `proposeFact` / `confirmFact` / `supersedeFact` /
 *                        `rejectFact` / `editFact` (facts).
 *
 * INTERNAL-by-intent, still barrel-exported (honest Tier 3, NOT enforced):
 * significance, standing-instructions, fact-policy, entity graph, signature,
 * self-identity, style-profiles, entity-metadata, rejected, extraction. Live
 * cross-module consumers (briefing/triage/replicache/tools) read these today,
 * so narrowing them behind observe/recall/contextFor/applyCorrection is a
 * deferred follow-up, not this relocation. NOTE: the pure `rememberSenderSuppression`
 * write is a public door here — prefer the `tools` suppression coordinator, which
 * also dismisses the matching todos.
 */
export * from "./types";
export * from "./signature";
export * from "./facts";
export * from "./fact-policy";
export * from "./self-identity";
export * from "./user-context";
export * from "./standing-instructions";
export * from "./chunks";
export * from "./entity-graph";
export * from "./entity-metadata";
export * from "./significance";
export * from "./team-graph";
export * from "./style-profiles";
export * from "./rejected";
export * from "./extraction";

// Worker lifecycle — names preserved so `runtime.ts` re-exports resolve unchanged.
export { startMemoryWorker, stopMemoryWorker, closeMemoryQueue } from "./queue";
export { scheduleRepeatableMemoryJobs } from "./repeatable";

// Product recipe owned by the knowledge module; the composition root builds it
// with the injected Gmail sender adapter (ADR-0089) and registers the result.
export { buildMemoryExtractionWorkflow } from "./memory-extraction";
