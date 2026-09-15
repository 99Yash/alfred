import {
  CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS,
  CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS,
  evidenceCardSchema,
  sanitizeErrorMessage,
  toMessage,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceExpansionHandle,
} from "@alfred/contracts";
import { expansionRoutes, type SourceExclusionReason } from "./manifest";
import type { ContextSource, ContextSourceExpander, ContextSourceResult } from "./registry";

/**
 * The expansion phase (#428/#1077; epic #422; ADR-0101 sub-decisions 17-18).
 *
 * `search.ts` collects, ranks, and truncates. This file owns what happens
 * AFTER that: the surviving cards are the only ones worth a provider round
 * trip, so the phase runs on the truncated list and never on the collected one.
 * Running it before the rank would pay for cards the `limit` was about to drop,
 * and it would let a live refresh change the very scores that decide the order.
 *
 * What the phase does, in one sentence: take each surviving card that is not
 * already live and carries an expansion handle, route that handle to a source
 * that declared its KIND, call those sources in parallel, and put each returned
 * card back at the rank position of the card it refreshed.
 *
 * Three rules hold it honest, and each has a failure it exists to prevent:
 *
 * - **Route by declared kind, never by name.** The handle carries a `sourceId`
 *   and the phase ignores it for routing. A card that picked its own reader
 *   would be the hard-coded source switch this boundary exists to remove.
 * - **Replace, never append.** A refreshed card takes the position of the card
 *   it refreshed, so the phase cannot grow the evidence past `request.limit`
 *   and cannot reorder a rank it did not compute.
 * - **A refresh must declare itself live.** The expanding source stamps
 *   `time.freshness: "live"`; the boundary never stamps it. A card the phase
 *   accepted without that declaration would be Alfred inferring freshness,
 *   which is the one thing the card contract forbids.
 *
 * A failure is local: the original card stays, and only an expansion-only
 * source carries the `error`. A source that already answered the query keeps
 * the status it earned there — an expansion answers a different question, so
 * its failure must not rewrite a healthy `ok` into an `error` beside the
 * source's own cards. An expansion that could not run is never allowed to cost
 * the read the local evidence it already had.
 */

/** What one expanding source did across every handle routed to it. */
export interface ExpanderOutcome {
  readonly sourceId: string;
  /** Cards this source refreshed. Zero means it was asked and returned none. */
  readonly refreshed: number;
  /** Sanitized text of its first failure, or `undefined` if it never failed. */
  readonly failure: string | undefined;
}

/** The result of one expansion phase, for `search.ts` to fold into its reports. */
export interface EvidenceExpansion {
  /** The surviving cards, with each refreshed card at the position it replaced. */
  readonly evidence: readonly EvidenceCard[];
  /** Per consulted expanding source, keyed by id. Absent means never consulted. */
  readonly expanders: ReadonlyMap<string, ExpanderOutcome>;
  /** Per ORIGIN source id, how many of its cards a refresh replaced. */
  readonly replaced: ReadonlyMap<string, number>;
}

/** One handle the phase decided to pay for, and who will read it. */
interface ExpansionPlan {
  /** Rank position of the card this expansion refreshes. */
  readonly index: number;
  readonly handle: EvidenceExpansionHandle;
  readonly source: ContextSource;
  readonly expander: ContextSourceExpander;
}

/** What one plan produced: a refreshed card, a failure, or neither. */
interface ExpansionAttempt {
  readonly plan: ExpansionPlan;
  readonly card: EvidenceCard | undefined;
  readonly failure: string | undefined;
}

/**
 * Refresh the surviving cards that a registered source can read live.
 *
 * Returns the evidence unchanged, and no outcome at all, when no route exists
 * or no surviving card carries a routable handle — so a read with no expander
 * registered pays nothing and reports nothing new.
 */
export async function expandEvidence(args: {
  readonly sources: readonly ContextSource[];
  readonly excluded: ReadonlyMap<string, SourceExclusionReason>;
  readonly evidence: readonly EvidenceCard[];
  readonly request: ContextSearchRequest;
}): Promise<EvidenceExpansion> {
  const routes = expansionRoutes(args.sources, args.excluded);

  if (routes.size === 0) return unchanged(args.evidence);

  const plans = planExpansions(args.evidence, routes);

  if (plans.length === 0) return unchanged(args.evidence);

  // Parallel on purpose: the phase is the read's only network cost, and running
  // N providers in series would make the read's latency the SUM of theirs. Each
  // attempt already swallows its own failure, so one slow or broken provider
  // cannot reject the batch — and the phase deadline below is what stops one
  // hung provider from DELAYING the batch past it. The count cap bounds how
  // many round trips the read pays for; only the deadline bounds how long it
  // waits for them.
  const deadline = AbortSignal.timeout(CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS);

  const attempts = await Promise.all(
    plans.map((plan) => runExpansionWithDeadline(plan, args.request, deadline)),
  );

  const evidence = [...args.evidence];
  const expanders = new Map<string, ExpanderOutcome>();
  const replaced = new Map<string, number>();

  for (const attempt of attempts) {
    const sourceId = attempt.plan.source.id;
    const prior = expanders.get(sourceId);

    if (attempt.card !== undefined) {
      const origin = args.evidence[attempt.plan.index];

      if (origin !== undefined) {
        replaced.set(origin.source.id, (replaced.get(origin.source.id) ?? 0) + 1);
      }

      evidence[attempt.plan.index] = attempt.card;
    }

    expanders.set(sourceId, {
      sourceId,
      refreshed: (prior?.refreshed ?? 0) + (attempt.card !== undefined ? 1 : 0),
      // The first failure is the reported one. A source that failed twice in
      // one read failed once as far as the model needs to know, and two
      // concatenated provider strings buy nothing over one.
      failure: prior?.failure ?? attempt.failure,
    });
  }

  return { evidence, expanders, replaced };
}

function unchanged(evidence: readonly EvidenceCard[]): EvidenceExpansion {
  return { evidence, expanders: new Map(), replaced: new Map() };
}

/**
 * Which handles this read will pay for, in rank order.
 *
 * Walks the surviving cards best-first and stops at
 * {@link CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS}, so the cap always spends its
 * budget on the strongest evidence. Three cards are passed over:
 *
 * - one that already declares itself `live` — there is nothing to refresh;
 * - one whose handle kind no source declared — routing is by declaration, and
 *   an unrouted handle is a card that stays exactly as it was;
 * - one whose `(kind, ref)` a better-ranked card already claimed — two cards
 *   pointing at one record cost ONE provider call. The refreshed card takes the
 *   better-ranked position; the other card keeps its own local content rather
 *   than becoming a second copy of the same card id.
 */
function planExpansions(
  evidence: readonly EvidenceCard[],
  routes: ReadonlyMap<string, ContextSource>,
): readonly ExpansionPlan[] {
  const plans: ExpansionPlan[] = [];
  const claimed = new Set<string>();

  for (const [index, card] of evidence.entries()) {
    if (plans.length >= CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS) break;

    const handle = card.expansion;

    if (handle === undefined || card.time?.freshness === "live") continue;

    const source = routes.get(handle.kind);

    if (source === undefined) continue;

    const expander = source.reads["expand"];

    if (expander === undefined) continue;

    // A NUL joins the two parts so one `(kind, ref)` pair cannot be spelled two
    // ways that collide; neither field may carry a NUL after contract
    // validation, so the key is unambiguous.
    const key = `${handle.kind}\u0000${handle.ref}`;

    if (claimed.has(key)) continue;

    claimed.add(key);
    plans.push({ index, handle, source, expander });
  }

  return plans;
}

/** What a timed-out expansion reports: our own words, never provider text. */
const EXPANSION_TIMEOUT_FAILURE = "the expansion timed out";

/**
 * Race one expansion against the phase deadline.
 *
 * The signal notifies cooperative expanders, but notification alone cannot
 * bound the batch: an expander that ignores the signal would still hold its
 * `Promise.all` slot forever. The race is what bounds it — on abort the phase
 * takes the timeout failure and stops waiting, while the stray promise settles
 * unobserved (`runExpansion` never rejects, so nothing escapes).
 */
function runExpansionWithDeadline(
  plan: ExpansionPlan,
  request: ContextSearchRequest,
  signal: AbortSignal,
): Promise<ExpansionAttempt> {
  if (signal.aborted) {
    return Promise.resolve({ plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE });
  }

  return new Promise<ExpansionAttempt>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve({ plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    runExpansion(plan, request, signal).then(
      (attempt) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(attempt);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ plan, card: undefined, failure: sanitizeErrorMessage(toMessage(error)) });
      },
    );
  });
}

/**
 * Run one expansion and validate what came back.
 *
 * A refreshed card is held to everything a collected card is held to, plus two
 * rules that only a replacement needs: it must name the source that produced it
 * (the manifest join key, exactly as in the first phase), and it must declare
 * itself `live`. A source that cannot promise live data has no business
 * replacing a card the local store already answered.
 *
 * The phase's abort signal travels with the call: a cooperative expander
 * cancels on it, and an abort during the call reports the timeout rather than
 * whatever the provider said on its way down.
 */
async function runExpansion(
  plan: ExpansionPlan,
  request: ContextSearchRequest,
  signal: AbortSignal,
): Promise<ExpansionAttempt> {
  if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

  let result: ContextSourceResult;

  try {
    result = await plan.expander({ request, handle: plan.handle, signal });
  } catch (error) {
    if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

    return { plan, card: undefined, failure: sanitizeErrorMessage(toMessage(error)) };
  }

  if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

  let first: unknown;

  try {
    // A source that returned a non-array `evidence` fails here rather than
    // rejecting the batch, exactly as a collected read does.
    [first] = result.evidence;
  } catch (error) {
    return { plan, card: undefined, failure: sanitizeErrorMessage(toMessage(error)) };
  }

  // No card is an honest answer: the record behind the handle is gone, or the
  // provider had nothing to add. The original card stays and the source reports
  // `empty`, never `error`.
  if (first === undefined) return { plan, card: undefined, failure: undefined };

  const parsed = evidenceCardSchema.safeParse(first);

  if (!parsed.success || parsed.data.source.id !== plan.source.id) {
    return { plan, card: undefined, failure: "the expanded evidence card violated the contract" };
  }

  if (parsed.data.time?.freshness !== "live") {
    return {
      plan,
      card: undefined,
      failure: "the expanded evidence card did not declare itself live",
    };
  }

  return { plan, card: parsed.data, failure: undefined };
}
