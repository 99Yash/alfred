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
export { type DbExecutor } from "./executor";
export { insertObservation, type InsertObservationResult } from "./observations";
export {
  ensureEntityNode,
  recordEntityIdentity,
  EntityIdentityConflictError,
  type RecordEntityIdentityArgs,
} from "./entities";
export {
  activateProjectionVersion,
  completeProjectionRun,
  failProjectionRun,
  startProjectionRun,
  writeProjectionCursor,
  type CompleteProjectionRunArgs,
  type StartProjectionRunArgs,
  type StartProjectionRunResult,
  type WriteProjectionCursorArgs,
} from "./projection";
export {
  userModelReader,
  type ActiveEntityProfile,
  type ActiveEntityEdge,
  type ActiveEntityCoOccurrence,
  type UserModelReader,
} from "./reader";
