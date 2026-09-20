import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * The Railway object-state adapter (#1094) — Railway's irreducible half of
 * reconciliation. v1 proposes NOTHING from text: no Railway deployment-URL
 * grammar exists yet, and an invented expression would only multiply the
 * candidates the resolve walks for keys that resolve to nothing. The row
 * satisfies the `OBJECT_STATE_ADAPTERS` completeness proof (a provider
 * without an adapter is a compile error); the structured follow-up —
 * deployment-URL grammar plus a text adapter — fills this file in.
 *
 * This is safe, not silent: proposal never asserts state (a wrong or absent
 * key resolves to nothing and closes nothing). A Railway loop's email item
 * is NOT dropped by reconciliation today — closure to the reader is the
 * verified pull's verdict line, and the target rows exist for the pull's
 * own trigger and dedup, read structurally by identity. When the
 * deployment-URL grammar lands and this adapter proposes keys, the
 * `deployment_target` closure declaration is restored alongside it.
 */
export const railwayObjectStateAdapter: ObjectStateAdapter = {
  provider: "railway",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
