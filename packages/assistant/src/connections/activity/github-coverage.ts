import type { GithubMergedReadOutcome } from "../verified-pull/github-merged-read";
import type { DeliveryGap, GapProof } from "./delivery-gaps";
import { readGithubActivityDocumentsBetween } from "./documents";
import { githubActOf, isGithubActRecorded, type GithubFamilyHead } from "./github-activity";

/**
 * The GitHub part of the activity coverage (ADR-0118 decision 4): the check that the record holds
 * the act of each GitHub delivery, and what the merged read proves about a delivery gap. Both use
 * the GitHub reducer, so they change with it.
 */

/**
 * The live head of each family in `familyKeys`. `knowledge` owns the observation tables, so the
 * caller passes its reader in.
 */
export type ReadFamilyHeads = (
  userId: string,
  familyKeys: readonly string[],
) => Promise<ReadonlyMap<string, GithubFamilyHead>>;

/** The deliveries that arrived in `[start, end)`, and the reader of the record. */
export interface UnrecordedActsArgs {
  readonly userId: string;
  readonly start: Date;
  readonly end: Date;
  readonly readFamilyHeads: ReadFamilyHeads;
}

/**
 * What the merged read (`is:pr is:merged author:@me`) proves about a GitHub gap. The read is a
 * provider call, so it sees a merge whose delivery never came. The coverage gives this function a
 * read only when the read covers the coverage window, so the part of a gap before the window start
 * is not checked. The read returns one page, so "no merge" is proof only when the page holds every
 * merge of the read.
 */
export function githubGapProof(read: GithubMergedReadOutcome, gap: DeliveryGap): GapProof {
  if (read.status !== "completed") return { kind: "unknown" };

  const { items, total } = read.read;

  // `mergedAt` is GitHub's time of the merge, and the gap bounds are arrival times. The delivery
  // that ends a gap can be the merge itself, and a delivery can still be in the queue, so only a
  // merge before `settledBy` is missed.
  const missedBefore = gap.settledBy.getTime();

  const missed = items.filter((item) => {
    const at = item.mergedAt.getTime();

    return (gap.from === null || at > gap.from.getTime()) && at < missedBefore;
  }).length;

  if (missed > 0) {
    return { kind: "missed", finding: `${missed} of the user's pull requests merged in that time` };
  }

  return items.length < total
    ? { kind: "unknown" }
    : { kind: "none", finding: "none of the user's pull requests merged in that time" };
}

/**
 * The acts of the user's GitHub deliveries in `[start, end)` that the record does not hold. The
 * same reducer as the writer names each act, so the check and the writer cannot disagree.
 */
export async function countUnrecordedGithubActs(args: UnrecordedActsArgs): Promise<number> {
  const { userId, start, end, readFamilyHeads } = args;
  const docs = await readGithubActivityDocumentsBetween({ userId, start, end });
  const acts = docs.flatMap((doc) => githubActOf(doc) ?? []);

  const familyKeys = new Set(
    acts.flatMap((act) => (act.ownFamilyKey ? [act.familyKey, act.ownFamilyKey] : [act.familyKey])),
  );

  const heads = await readFamilyHeads(userId, [...familyKeys]);

  return acts.filter((act) => !isGithubActRecorded(act, (key) => heads.get(key))).length;
}
