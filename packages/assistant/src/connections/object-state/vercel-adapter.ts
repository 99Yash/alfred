import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * Vercel adapter (#1167). Proposes nothing from text: no Vercel deploy notification has reached the
 * mailbox, so there is no grammar to derive. Exists to keep `OBJECT_STATE_ADAPTERS` complete.
 * Target rows are still folded and read by identity. Add a grammar, and restore the
 * `deployment_target` closure declaration, once a real notification exists.
 */
export const vercelObjectStateAdapter: ObjectStateAdapter = {
  provider: "vercel",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
