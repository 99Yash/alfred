/**
 * Multi-source user-model substrate — write boundary + read surface (ADR-0067, #218).
 *
 * P0 shipped the schema + contracts (no writers). This module is the P1
 * foundation: the ONLY sanctioned way to write to / read from the substrate.
 *
 *   - `insertObservation` — the HARD write gate (validated append + head upsert).
 *   - `ensureEntityNode` / `recordEntityIdentity` — the stable-layer write API.
 *   - `startProjectionRun` / `completeProjectionRun` / `failProjectionRun` /
 *     `writeProjectionCursor` / `activateProjectionVersion` — projection lifecycle,
 *     including the completed-only activation guard a FK can't express.
 *   - `userModelReader` — the active-projection read surface; consumers read this,
 *     never raw `WHERE projection_version = active`.
 *
 * Reducers, the fold, and consumer cutover (briefing/triage/todos) build on these.
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
