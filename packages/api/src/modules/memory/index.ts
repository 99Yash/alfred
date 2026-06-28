/**
 * Memory primitives (ADRs 0012, 0013, 0019).
 *
 * `proposeFact` / `confirmFact` / `rejectFact` / `editFact` / `supersedeFact`
 * cover the user_facts lifecycle. `recallActiveByKey` / `recallLatestByKey`
 * are the read paths agents use to fetch "what does alfred know about X".
 *
 * `setPreference` / `getPreference` cover user-driven settings.
 *
 * `writeMemoryChunk` / `recallMemory` cover semantic recall over alfred's
 * interpretation layer (summaries, research notes) — distinct from the
 * `chunks` table which slices ingested integration content.
 *
 * `upsertEntity` / `linkEntities` / `getRelatedEntities` cover the
 * lightweight in-DB graph; `upsertStyleProfile` / `getStyleProfile`
 * cover drafting profiles (table CRUD only — generation deferred to m9).
 *
 * `isRejected` / `listRejections` / `recordRejection` cover the
 * extraction sub-agent's pre-propose check.
 */

export * from "./types";
export * from "./signature";
export * from "./facts";
export * from "./fact-policy";
export * from "./self-identity";
export * from "./preferences";
export * from "./user-context";
export * from "./standing-instructions";
export * from "./chunks";
export * from "./entities";
export * from "./entity-metadata";
export * from "./significance";
export * from "./team-graph";
export * from "./style-profiles";
export * from "./rejected";
export * from "./extraction";
export {
  startMemoryWorker,
  stopMemoryWorker,
  closeMemoryQueue,
  getMemoryQueue,
  enqueueExtractionForUser,
  type MemoryJobData,
} from "./queue";
export { scheduleRepeatableMemoryJobs } from "./repeatable";
