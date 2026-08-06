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
