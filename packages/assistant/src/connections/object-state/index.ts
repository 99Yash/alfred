export {
  objectStateStore,
  type ApplyEventArgs,
  type ObjectListFilter,
  type ObjectState,
  type ObjectStateDelta,
  type ObjectStateRef,
  type ObjectStateStore,
} from "./store";

export { reduceGithubEvent } from "./github-reducer";

export {
  type CandidateKey,
  type KeyProposal,
  type ReconcileSubject,
  type SubjectText,
} from "./adapter";

export {
  firstClosingObject,
  proposeObjectKeys,
  reconcileEvidence,
  type ReconcileCandidates,
  type ReconcileResult,
  type ReconciledObject,
} from "./reconcile";

export { githubActivityTriggerConsumer } from "./github-activity-consumer";
