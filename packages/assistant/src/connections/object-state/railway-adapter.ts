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
 * key resolves to nothing and closes nothing), and closure of a Railway loop
 * rides on the verified pull's target rows, read structurally by identity.
 */
export const railwayObjectStateAdapter: ObjectStateAdapter = {
  provider: "railway",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
