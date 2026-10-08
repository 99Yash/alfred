/**
 * `knowledge`: the one door to Alfred's knowledge substrate.
 *
 * Observe (ADR-0067): `insertObservation` is the hard write gate. Consumers read
 * through `userModelReader`, never raw `WHERE projection_version = active`.
 * The chat extractor (`./extractor`) writes nothing durable.
 *
 * Terminology: see `docs/reference/glossary.md`.
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

export { projectGmailWorksAtEdges, type ProjectGmailWorksAtEdgesResult } from "./gmail-edge-fold";

export {
  globalReferentIdentity,
  referentKeyForEmail,
  senderScopedReferentIdentity,
  REFERENT_IDENTITY_KIND,
  type GlobalReferentKey,
  type ReferentEvidence,
  type ReferentKey,
  type ReferentKeyInput,
  type ReferentThreadingHeaders,
  type SenderScopedReferentKey,
} from "./referent-identity";

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
 * ── recall · contextFor · applyCorrection ───────────────────────────────────
 * These groupings are documentary; nothing stops a "recall" export from writing.
 *
 * This barrel is curated: callers outside the module get only what they need.
 * `internal.ts` is the tooling door for `apps/server` scripts, fenced by an
 * `.oxlintrc.json` rule. The `package.json` `exports` map decides which files are
 * reachable at all, and a listed subpath bypasses this barrel.
 */
export {
  recallActiveByKey,
  recallLatestByKey,
  listFactsByStatus,
  getSupersessionChain,
  proposeFact,
  confirmFact,
  supersedeFact,
  rejectFact,
  editFact,
  proposeFactArgsSchema,
  type FactRow,
  type ProposeFactArgs,
  FACT_STATUSES,
  factStatusSchema,
  AUTO_CONFIRM_THRESHOLD,
  type FactStatus,
} from "./facts";

// recall (chunks) + the cold-start write door.
export {
  recallMemory,
  writeMemoryChunk,
  type RecallMemoryHit,
  MEMORY_CHUNK_KINDS,
  memoryChunkKindSchema,
  type MemoryChunkKind,
  USER_FACING_MEMORY_CHUNK_KINDS,
} from "./chunks";

// The `./style-profiles` subpath also exports the CRUD.
export {
  STYLE_CHANNELS,
  styleChannelSchema,
  type StyleChannel,
  STYLE_AUDIENCE_BUCKETS,
  styleAudienceBucketSchema,
  type StyleAudienceBucket,
} from "./style-profiles";

export { ENTITY_KINDS, entityKindSchema, type EntityKind } from "./entity-graph";

// Shared by the triage parser and the sender-kind floor (#1187).
export { isExactGroupLocal, isGroupLocal } from "./entity-kind-classifier";

export { readUserContext, type UserContext } from "./user-context";

// Cross-module helpers for replicache, triage, briefing, tools, and todos.
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
  // Prefer the `tools` suppression coordinator: it also dismisses the matching todos.
  rememberSenderSuppression,
  type RememberSenderSuppressionArgs,
  type RememberSenderSuppressionResult,
  type SenderSuppressionMatch,
} from "./standing-instructions";

export { startMemoryWorker, stopMemoryWorker, closeMemoryQueue } from "./queue";

export { scheduleRepeatableMemoryJobs } from "./repeatable";

// The composition root builds this with the Gmail sender adapter (ADR-0089).
export { buildMemoryExtractionWorkflow } from "./memory-extraction";

// One result value per memory-extraction run (#1109). The smoke parses it from `agent_runs.output`.
export {
  describeMemoryExtractionOutcome,
  memoryExtractionOutcomeSchema,
  summarizeMemoryExtractionRun,
  type MemoryExtractionOutcome,
  type MemoryExtractionRunCounts,
} from "./memory-extraction-outcome";

// The cold-start prior for triage (ADR-0050 D1). One indexed point read; no memory search on the hot path.
export { readUserContextLine, type UserContextLine } from "./user-context-line";

// ── memory acquisition sub-areas: cold-start research, drift audit, web search ──
export * from "./cold-start";

export * from "./drift-audit";

export { runWebSearch, type WebSearchArgs, type WebSearchResult } from "./web-search";
