import { collectRailwayTargetIds, isRailwaySender } from "./railway-mail";
import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * Railway object-state adapter (ADR-0062, #1094). Key proposal only. Proposes the
 * `deployment_target` id from a Railway service URL, as the build-failure mail links it. The
 * target closes from `live_confirmation`, so only a consumer with a live Railway read may close.
 */

function targetKeys(ids: readonly string[]): ExtractedKey[] {
  return ids.map((id) => ({ keyKind: "deployment_target", keyValue: id, match: "exact" }));
}

/**
 * - `about`: needs the Railway sender gate, and only an exactly-one target, because the briefing
 *   drops an item on it.
 * - `mentions` and `annotates`: every target URL. No provenance needed.
 */
export const railwayObjectStateAdapter: ObjectStateAdapter = {
  provider: "railway",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    const ids = collectRailwayTargetIds(`${subject.text.subject}\n${subject.text.content}`);

    if (proposal.reading !== "about") return targetKeys(ids);

    if (!isRailwaySender(proposal.sender)) return [];

    return ids.length === 1 ? targetKeys(ids) : [];
  },
};
