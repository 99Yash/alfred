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
import { expansionRoutes } from "./manifest";
import { cardManifestViolation, type ContextSource, type ContextSourceExpander } from "./registry";

/**
 * Expansion phase (#1077, ADR-0101 sub-decisions 17-18). Runs after the rank
 * and the `limit` cut, so it pays only for surviving cards and cannot change scores.
 * - Route by the handle's declared kind, never by its `sourceId`.
 * - Replace, never append: a refresh takes its origin's rank position.
 * - The refresh must declare itself `live` and echo the requested `(kind, ref)`.
 * A failure keeps the original card. `search.ts` reports it as `error`.
 */

/** What one expanding source did across every handle routed to it. */
export interface ExpanderOutcome {
  readonly sourceId: string;
  readonly refreshed: number;
  /** The first failure, sanitized. */
  readonly failure: string | undefined;
}

export interface EvidenceExpansion {
  readonly evidence: readonly EvidenceCard[];
  /** Absent means never consulted. */
  readonly expanders: ReadonlyMap<string, ExpanderOutcome>;
  /** Replaced cards per origin source id. */
  readonly replaced: ReadonlyMap<string, number>;
}

interface ExpansionPlan {
  readonly index: number;
  readonly handle: EvidenceExpansionHandle;
  readonly source: ContextSource;
  readonly expander: ContextSourceExpander;
}

interface ExpansionAttempt {
  readonly plan: ExpansionPlan;
  readonly card: EvidenceCard | undefined;
  readonly failure: string | undefined;
}

/** Refresh surviving cards that a source can read live. No route or no handle costs nothing. */
export async function expandEvidence(args: {
  readonly sources: readonly ContextSource[];
  readonly evidence: readonly EvidenceCard[];
  readonly request: ContextSearchRequest;
}): Promise<EvidenceExpansion> {
  const routes = expansionRoutes(args.sources, args.request);

  if (routes.size === 0) return unchanged(args.evidence);

  const plans = planExpansions(args.evidence, routes);

  if (plans.length === 0) return unchanged(args.evidence);

  // Parallel, so latency is the slowest provider, not the sum. The count cap
  // bounds the calls; the deadline bounds the wait.
  const deadline = AbortSignal.timeout(CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS);

  const attempts = await Promise.all(
    plans.map((plan) => runExpansionWithDeadline(plan, args.request, deadline)),
  );

  const evidence = [...args.evidence];
  const expanders = new Map<string, ExpanderOutcome>();
  const replaced = new Map<string, number>();
  const originIds = new Set(args.evidence.map((card) => card.id));
  const acceptedIds = new Set<string>();

  for (const attempt of attempts) {
    const sourceId = attempt.plan.source.id;
    const prior = expanders.get(sourceId);

    let card = attempt.card;
    let failure = attempt.failure;

    if (card !== undefined) {
      // Accept only the origin's own id or a fresh one, so no id appears twice.
      const origin = args.evidence[attempt.plan.index];

      const collides =
        origin === undefined ||
        (card.id !== origin.id && (originIds.has(card.id) || acceptedIds.has(card.id)));

      if (collides) {
        card = undefined;
        failure ??= "the expanded evidence card duplicated another card's id";
      } else {
        acceptedIds.add(card.id);
      }
    }

    if (card !== undefined) {
      const origin = args.evidence[attempt.plan.index];

      if (origin !== undefined) {
        replaced.set(origin.source.id, (replaced.get(origin.source.id) ?? 0) + 1);
      }

      evidence[attempt.plan.index] = card;
    }

    expanders.set(sourceId, {
      sourceId,
      refreshed: (prior?.refreshed ?? 0) + (card !== undefined ? 1 : 0),
      // Report only the first failure.
      failure: prior?.failure ?? failure,
    });
  }

  return { evidence, expanders, replaced };
}

function unchanged(evidence: readonly EvidenceCard[]): EvidenceExpansion {
  return { evidence, expanders: new Map(), replaced: new Map() };
}

/**
 * Handles to pay for, best-ranked first, up to {@link CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS}.
 * Skips a card already read, a kind no source declared, and a `(kind, ref)`
 * a better-ranked card already claimed.
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

    if (handle === undefined || isAlreadyRead(card)) continue;

    const source = routes.get(handle.kind);

    if (source === undefined) continue;

    const expander = source.reads["expand"];

    if (expander === undefined) continue;

    // JSON, not a NUL join: both fields may contain NUL, so a join could collide.
    const key = JSON.stringify([handle.kind, handle.ref]);

    if (claimed.has(key)) continue;

    claimed.add(key);
    plans.push({ index, handle, source, expander });
  }

  return plans;
}

/**
 * Read now = `live` and has a snippet (#1078). A live Drive hit with only a
 * note was found but not read, so it still needs expansion.
 */
function isAlreadyRead(card: EvidenceCard): boolean {
  return card.time?.freshness === "live" && card.snippet !== undefined;
}

/** Our own words, never provider text. */
const EXPANSION_TIMEOUT_FAILURE = "the expansion timed out";

/**
 * Race one expansion against the deadline. The race bounds an expander that
 * ignores the signal. `runExpansion` never rejects, so the stray promise is safe.
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
 * Run one expansion and validate the card like a collected card, plus: `live`,
 * and an echo of the requested `(kind, ref)`. `sourceId` and `hint` are not compared.
 * An abort during the call reports the timeout, not the provider's error.
 */
async function runExpansion(
  plan: ExpansionPlan,
  request: ContextSearchRequest,
  signal: AbortSignal,
): Promise<ExpansionAttempt> {
  if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

  let result: EvidenceCard | undefined;

  try {
    result = await plan.expander({ request, handle: plan.handle, signal });
  } catch (error) {
    if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

    return { plan, card: undefined, failure: sanitizeErrorMessage(toMessage(error)) };
  }

  if (signal.aborted) return { plan, card: undefined, failure: EXPANSION_TIMEOUT_FAILURE };

  // No card: the record is gone or had nothing new. Not a failure.
  if (result === undefined) return { plan, card: undefined, failure: undefined };

  const parsed = evidenceCardSchema.safeParse(result);

  // Same checks as the collect phase (#429), so expansion is no back door.
  if (!parsed.success) {
    return { plan, card: undefined, failure: "the expanded evidence card violated the contract" };
  }

  const violation = cardManifestViolation(parsed.data, plan.source);

  if (violation !== undefined) {
    return {
      plan,
      card: undefined,
      failure: `the expanded evidence card violated the contract: ${violation}`,
    };
  }

  if (parsed.data.time?.freshness !== "live") {
    return {
      plan,
      card: undefined,
      failure: "the expanded evidence card did not declare itself live",
    };
  }

  // A card about another record must not take this rank position.
  const returned = parsed.data.expansion;

  if (
    returned === undefined ||
    returned.kind !== plan.handle.kind ||
    returned.ref !== plan.handle.ref
  ) {
    return {
      plan,
      card: undefined,
      failure: "the expanded evidence card did not match the requested record",
    };
  }

  return { plan, card: parsed.data, failure: undefined };
}
