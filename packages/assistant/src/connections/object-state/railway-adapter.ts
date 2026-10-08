import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * Railway adapter (#1094). Proposes nothing from text: no deployment-URL grammar exists yet. Exists
 * to keep `OBJECT_STATE_ADAPTERS` complete. Closure for the reader comes from the verified pull's
 * verdict line. Restore the `deployment_target` closure declaration with the grammar.
 */
export const railwayObjectStateAdapter: ObjectStateAdapter = {
  provider: "railway",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
