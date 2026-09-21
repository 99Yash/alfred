import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * The Vercel object-state adapter (#1167) — Vercel's irreducible half of
 * reconciliation. v1 proposes NOTHING from text, for a measured reason rather
 * than a cautious one: no Vercel deployment notification has ever reached
 * this mailbox. The only two Vercel-looking documents in the corpus are a
 * marketing mail from `ship@info.vercel.com` and a GitHub comment relay from
 * `notifications@github.com`, so there is no written form to derive a subject
 * or body grammar from. An invented expression would only multiply the
 * candidates the resolve walks for keys that resolve to nothing.
 *
 * The row satisfies the `OBJECT_STATE_ADAPTERS` completeness proof (a
 * provider without an adapter is a compile error), exactly as Railway's does.
 * When a real Vercel notification exists, the grammar is derived from it, the
 * sender gate reads `INTEGRATIONS.vercel.domain` rather than a second
 * literal, and the `deployment_target` `closesAskOn: ["resolved"]`
 * declaration is restored alongside it.
 *
 * This is safe, not silent: proposal never asserts state (a wrong or absent
 * key resolves to nothing and closes nothing). The target rows still exist
 * and are still folded — chat, context search and the day-shape list read
 * them structurally by identity, which is the half of #1167 that does land.
 */
export const vercelObjectStateAdapter: ObjectStateAdapter = {
  provider: "vercel",
  proposeKeys(_subject: ReconcileSubject, _proposal: KeyProposal): ExtractedKey[] {
    return [];
  },
};
