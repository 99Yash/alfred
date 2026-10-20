import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * Railway adapter (ADR-0062, #1094). Proposes nothing from text. The build-failure mail names a
 * `deployment_target` through identity containment (ADR-0109): its link holds the project,
 * service, and environment ids that the registry declares. Exists to keep `OBJECT_STATE_ADAPTERS`
 * complete.
 */
export const railwayObjectStateAdapter: ObjectStateAdapter = {
  provider: "railway",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
