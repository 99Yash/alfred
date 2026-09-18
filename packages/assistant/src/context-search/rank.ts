import type {
  ContextObjectRef,
  EvidenceAuthorityLevel,
  EvidenceCard,
  EvidenceFreshness,
  SourceCostClass,
  SourceManifest,
  StateCategory,
} from "@alfred/contracts";
import { clamp01 } from "@alfred/contracts";

/**
 * The deterministic evidence ranker (#427; epic #422; ADR-0101 sub-decision 7).
 *
 * Slice 1 returned cards in source-registration order and truncated the
 * combined list, so a productive later source could be dropped whole by an
 * earlier one. This file replaces that order with one cross-source ranking.
 *
 * Contract (ADR-0101 sub-decision 12 is the source of truth — this header
 * states only the shape so the two cannot drift): pure function over declared
 * card fields, no model call, `now` is an input; an absent signal drops its
 * feature from the card's weighted average rather than defaulting to zero —
 * except `freshness`, `authority`, and `semantic`, which read silence as a
 * defined row (`unknown` for the first two, low relevance for `semantic`,
 * #1078); `score` normalizes WITHIN its source; the per-card working rides
 * parallel to the evidence and never reaches the packer. The ranker never
 * reads `snippet` or `note` text.
 */

/**
 * One ranking input. Each is a documented reading of a card field, normalized
 * to `[0, 1]` where higher means "rank this higher".
 *
 * The union is exhaustive on purpose: `FEATURE_WEIGHTS` below is typed by it,
 * so a new feature is a compile error until it declares a weight.
 */
export const EVIDENCE_RANK_FEATURES = [
  "semantic",
  "exactMatch",
  "recency",
  "freshness",
  "authority",
  "sourcePriority",
  "objectState",
  "focus",
  "userModel",
] as const;

export type EvidenceRankFeature = (typeof EVIDENCE_RANK_FEATURES)[number];

/**
 * Relative pull of each feature. They are weights in a weighted AVERAGE, not a
 * sum, so they need not total 1. A card missing an OPTIONAL feature
 * (`exactMatch`, `recency`, `sourcePriority`, `objectState`, `focus`,
 * `userModel`) is not penalized for the missing weight — the average runs over
 * what it supplies. `semantic`, `freshness`, and `authority` are never missing
 * (each reads silence as a defined row), so the lead relevance feature cannot
 * drop out of the average it leads.
 *
 * The ordering of the numbers is the actual decision here:
 *
 * - `semantic` leads, because a retrieval score is still the strongest single
 *   reading of "does this answer the query".
 * - `exactMatch` is a tie-breaker, not a second lead: a deterministically
 *   resolved work object outranks a weak fuzzy hit, but a stale resolved object
 *   must not outrank a perfect fresh document on this feature alone. It sits
 *   with `sourcePriority` for that reason, and it is present only on cards
 *   whose object says `relation: "is"` — a vector card is not penalized for a
 *   retrieval mode it did not use.
 * - `recency` and `freshness` are separate readings and both matter: `recency`
 *   is how old the EVENT is, `freshness` is how stale ALFRED'S COPY of it is. A
 *   live read of an old record and an ingested copy of a new one are different
 *   facts, so one number cannot carry both.
 * - `authority` is deliberately mid-weight. It is a trust prior, not a
 *   relevance reading; letting it lead would rank a high-authority irrelevance
 *   over a low-authority answer.
 * - `sourcePriority` is the manifest seam (#466) and stays small, so a manifest
 *   that later declares priorities reorders ties rather than overturning the
 *   retrieval score.
 * - `objectState`, `focus`, and `userModel` are tie-breakers by design. They
 *   each carry real information, and each one is absent often enough that a
 *   large weight would make the order depend mostly on which cards happened to
 *   carry it.
 */
const FEATURE_WEIGHTS = {
  semantic: 0.3,
  exactMatch: 0.08,
  recency: 0.14,
  freshness: 0.1,
  authority: 0.1,
  sourcePriority: 0.08,
  objectState: 0.06,
  focus: 0.06,
  userModel: 0.06,
} as const satisfies Record<EvidenceRankFeature, number>;

/**
 * Half-life of the `recency` feature, in days. A two-week-old record scores
 * half of a record from today, a month-old record a quarter. The curve is
 * smooth on purpose: a cliff would make two records either side of a threshold
 * rank far apart for a one-second difference in age.
 */
const RECENCY_HALF_LIFE_DAYS = 14;

// Unit conversion, not calendar math: a fixed 86_400_000 ms per day for the
// exponential-decay denominator. Calendar-day readings belong on
// `@alfred/assistant/time` keys, never on millisecond arithmetic.
const MS_PER_DAY = 86_400_000;

/**
 * Decimal places the combined score is rounded to before cards are compared.
 *
 * Without it the order is at the mercy of floating-point noise: two cards that
 * are arithmetically tied can differ in the last bit of a `0.1 + 0.2` sum, and
 * which one wins would then depend on the order the features happened to be
 * added. Rounding first makes such a pair a real tie, which the stable
 * `id` comparison then breaks the same way on every run.
 */
const SCORE_PRECISION = 6;

/**
 * How current Alfred's COPY of the evidence is (#423's `EvidenceTime`).
 *
 * `live` was read from the provider for this search, so it cannot be wrong.
 * `ingested` is a local index that was correct when written. `stale` is the
 * source's own admission that its copy is past its freshness window, so it
 * scores below a source that simply could not say (`unknown`) — a declared
 * problem is worse evidence than an undeclared one.
 */
const FRESHNESS_SCORES = {
  live: 1,
  ingested: 0.6,
  unknown: 0.35,
  stale: 0.1,
} as const satisfies Record<EvidenceFreshness, number>;

/**
 * Trust prior from the source capability manifest (#466), when a source
 * declares one.
 *
 * `unknown` sits just ABOVE `low` and far below `medium`. That is the
 * conservative reading the card contract asks for in both directions: an
 * undescribed MCP source is never promoted toward `high` for its silence, and
 * it is never pushed below a source that honestly declared itself
 * low-authority either. Silence is not a confession.
 */
const AUTHORITY_SCORES = {
  high: 1,
  medium: 0.65,
  unknown: 0.35,
  low: 0.3,
} as const satisfies Record<EvidenceAuthorityLevel, number>;

/**
 * What one read of a source costs, as a ranking reading (#466).
 *
 * Cost is the weakest of the three manifest readings and it only ever breaks a
 * tie: a local store is preferred over a provider call when nothing else
 * separates them, and never over relevance. The ordering is the selection
 * ladder in the other direction (`manifest.ts`): a provider call costs money
 * AND the read's latency, so `remote` is the honest bad case and `unknown`
 * again sits above it, so a source is not punished for silence.
 */
const COST_SCORES = {
  local: 1,
  metered: 0.6,
  unknown: 0.5,
  remote: 0.35,
} as const satisfies Record<SourceCostClass, number>;

/**
 * Relevance reading for a card whose source measured none (#1078).
 *
 * Drive is the first source that cannot score its own hits: `fullText
 * contains` either matches or it does not, so every Drive card arrives with no
 * `score` and `normalizeSemanticScores` yields no entry. Dropping the feature
 * there did not treat the card neutrally — it removed the only feature that
 * could lower the card, and the average over the remaining trust signals
 * (`live`, `high`) promoted a text-less pointer above measured evidence. This
 * is the same omission-reward the manifest fold already refuses: its divisor
 * is the fixed total weight for exactly this reason.
 *
 * The floor reads as LOW relevance: above an explicit non-match (`score: 0`,
 * the object-state MISS that resolved nothing — a keyword match did match),
 * and below the `unknown` trust rows (0.35), because relevance leads the
 * average and unknown relevance must not outpull weak measured relevance. The
 * exact number is a judgement for the retrieval eval (#430) to tune, like the
 * other weights; the structural promise is only that the lead feature is
 * always present, so omission can never again read as a declared maximum.
 */
const SEMANTIC_UNKNOWN_SCORE = 0.3;

/**
 * Relative pull of the three manifest readings inside one source's priority.
 *
 * The keys name `SourceManifest` fields, and the `Record` checks the copy:
 * renaming a manifest field is a compile error here rather than a silently
 * stale weight. Authority leads by a wide margin because it is the only one
 * of the three that says anything about whether the source's evidence is
 * RIGHT. Freshness is a property of the copy, and cost is an operational
 * preference with no bearing on truth at all — hence the small tail. The fold
 * divides by the FIXED total weight and reads an undeclared axis as `unknown`,
 * so silence and a declared `unknown` agree and omission buys nothing.
 */
const MANIFEST_PRIORITY_WEIGHTS = {
  authority: 0.6,
  freshness: 0.25,
  cost: 0.15,
} as const satisfies Record<keyof Pick<SourceManifest, "authority" | "freshness" | "cost">, number>;

/** Fixed divisor for the manifest fold: the sum of every manifest weight. */
const MANIFEST_PRIORITY_TOTAL_WEIGHT =
  MANIFEST_PRIORITY_WEIGHTS.authority +
  MANIFEST_PRIORITY_WEIGHTS.freshness +
  MANIFEST_PRIORITY_WEIGHTS.cost;

/**
 * Fold one manifest into the single `[0, 1]` priority the `sourcePriority`
 * feature reads (#466; ADR-0101 sub-decision 13).
 *
 * Every axis always contributes: a declared reading scores its declared value
 * and an undeclared axis scores its `unknown` row, so a manifest that declares
 * only authority agrees with one that declares `unknown` freshness and cost
 * outright. The divisor is the fixed total weight, never the weight of the
 * readings the manifest happened to declare — dividing by the present weight
 * rewarded omission, because an omitted axis then read as a declared maximum
 * and every honest sub-maximum declaration lowered the result.
 *
 * The numbers live here rather than in the manifest contract because they are
 * ranking judgements, not facts about a source. `@alfred/contracts` states what
 * a manifest MEANS; this file decides what a ranker does about it, and a
 * reweighting is then one file's change.
 */
export function sourcePriorityFromManifest(manifest: SourceManifest): number {
  const authority =
    manifest.authority !== undefined
      ? AUTHORITY_SCORES[manifest.authority.level]
      : AUTHORITY_SCORES.unknown;

  const freshness =
    manifest.freshness !== undefined
      ? FRESHNESS_SCORES[manifest.freshness.typical]
      : FRESHNESS_SCORES.unknown;

  const cost = manifest.cost !== undefined ? COST_SCORES[manifest.cost.class] : COST_SCORES.unknown;

  // No clamp: every axis scores a `[0, 1]` row and the divisor is the fixed
  // total weight, so the weighted average cannot leave `[0, 1]`.
  return (
    (authority * MANIFEST_PRIORITY_WEIGHTS.authority +
      freshness * MANIFEST_PRIORITY_WEIGHTS.freshness +
      cost * MANIFEST_PRIORITY_WEIGHTS.cost) /
    MANIFEST_PRIORITY_TOTAL_WEIGHT
  );
}

/**
 * Lifecycle reading for object-state evidence (#425).
 *
 * `active` leads because open work is what a question about current state
 * usually means. `failed` is second, not last: a failed object is terminal for
 * the work object but it is normally the ALERT — the thing the user needs to
 * see — not a closed loop (the same reading `LOOP_CLOSING_STATE_CATEGORIES`
 * already takes). `resolved` and `abandoned` are finished work and rank last.
 */
const OBJECT_STATE_SCORES = {
  active: 1,
  failed: 0.7,
  resolved: 0.45,
  abandoned: 0.25,
} as const satisfies Record<StateCategory, number>;

/**
 * Optional signals the boundary supplies per read. Every field except `now`
 * is optional because each one has a real absent case, and the ranker's
 * contract is that an absent signal drops its feature rather than defaulting
 * it.
 */
export interface EvidenceRankContext {
  /** The instant `recency` decays from. An input, never `Date.now()` inside. */
  readonly now: Date;
  /**
   * The exact object references the caller declared on the request. They are
   * the caller's stated focus, so evidence about them is ranked up.
   */
  readonly objects?: readonly ContextObjectRef[];
  /**
   * Per-source priority in `[0, 1]`, keyed by `ContextSource.id`.
   *
   * This is the #466 seam. The manifest declares a source's authority,
   * freshness, and cost; the boundary folds them into one priority per source
   * and passes it here. Every consulted source folds to a number (an undeclared
   * axis scores its `unknown` row), so through `searchContext` the feature is
   * present on every card and moves every combined score slightly toward the
   * declared trust reading; the weight stays small so it reorders ties rather
   * than overturning relevance. A source missing from the map degrades the
   * same way as before: the feature drops from that card's average.
   */
  readonly sourcePriority?: ReadonlyMap<string, number>;
  /**
   * Per-entity user-model weight in `[0, 1]`, keyed by
   * `${identity.kind}:${identity.value}` (see {@link entitySignificanceKey}).
   *
   * Seam for #431. No builder lives in this slice: `searchContext` passes no
   * map today, so the `userModel` feature is absent from every card — the same
   * path an unknown entity takes afterwards.
   */
  readonly entitySignificance?: ReadonlyMap<string, number>;
}

/**
 * One card's ranking, for tests and debugging.
 *
 * This is deliberately NOT a field on `EvidenceCard`. The card is the shared
 * contract the packer renders for the model, and a per-feature score breakdown
 * is Alfred's internal reasoning about its own retrieval — interesting to a
 * developer reading a trace, noise (or worse, a lever) in a prompt. Keeping it
 * on a parallel array means `packEvidenceCards` cannot leak it by accident: it
 * never receives it.
 */
export interface EvidenceRanking {
  /** The `EvidenceCard.id` this ranking belongs to. */
  readonly cardId: string;
  /** The producing `ContextSource.id`, so a trace can group by source. */
  readonly sourceId: string;
  /** Combined score in `[0, 1]`, rounded to {@link SCORE_PRECISION}. */
  readonly score: number;
  /**
   * The features that were present, with their normalized readings.
   * `freshness`, `authority`, and `semantic` are always present (each reads
   * silence as a defined row); any other feature the card could not supply is
   * absent from this record rather than present with a zero, so a trace shows
   * the difference between "scored badly" and "could not be scored".
   */
  readonly features: Readonly<Partial<Record<EvidenceRankFeature, number>>>;
}

/** The ranked read: cards in final order, plus the parallel ranking metadata. */
export interface RankedEvidence {
  readonly evidence: readonly EvidenceCard[];
  readonly ranking: readonly EvidenceRanking[];
}

/**
 * The key an entity identity is looked up by in
 * {@link EvidenceRankContext.entitySignificance}.
 *
 * Exported so the signal builder and the ranker cannot drift into two spellings
 * of the same key. The value is already canonical for its kind — the card
 * contract derives its entity ref from `identityRefSchema`, which refuses a
 * value `canonicalizeIdentityValue` would change — so this concatenates rather
 * than re-normalizing.
 */
export function entitySignificanceKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

/**
 * Rank evidence across sources.
 *
 * Cards arrive grouped by source, each group already in its own source's order.
 * The result is one order over all of them: every card is scored as a weighted
 * average of the features it can supply, ties break on `id`, and the caller
 * truncates to its own budget afterwards. Truncation after ranking is the whole
 * point — the pre-#427 boundary truncated before it, so a strong card from a
 * late-registered source could never be seen.
 */
export function rankEvidenceCards(
  cards: readonly EvidenceCard[],
  context: EvidenceRankContext,
): RankedEvidence {
  if (cards.length === 0) return { evidence: [], ranking: [] };

  const semantic = normalizeSemanticScores(cards);
  const focus = focusMatcher(context.objects);

  const scored = cards.map((card) => {
    const features = cardFeatures(card, { context, semantic, focus });

    return {
      card,
      ranking: {
        cardId: card.id,
        sourceId: card.source.id,
        score: weightedAverage(features),
        features,
      } satisfies EvidenceRanking,
    };
  });

  // Highest score first; `id` ascending breaks a tie. The id tie-break is what
  // makes the order stable rather than merely sorted: `EvidenceCard.id` is
  // contractually reproducible for the same underlying record, so two reads of
  // the same corpus return the same sequence and a retrieval eval (#430) can
  // assert on positions.
  scored.sort((a, b) => b.ranking.score - a.ranking.score || compareIds(a.card.id, b.card.id));

  return {
    evidence: scored.map((entry) => entry.card),
    ranking: scored.map((entry) => entry.ranking),
  };
}

/**
 * Compare two card ids by code unit, not by locale.
 *
 * `localeCompare` answers differently under different ICU data, so a ranking
 * that tie-breaks with it is reproducible on one machine and not across two.
 * A tie-break only has to be TOTAL and STABLE, never human-alphabetical.
 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;

  return a < b ? -1 : 1;
}

interface FeatureInputs {
  readonly context: EvidenceRankContext;
  readonly semantic: ReadonlyMap<EvidenceCard, number>;
  readonly focus: (card: EvidenceCard) => number | undefined;
}

/**
 * Every feature one card can supply. `freshness`, `authority`, and `semantic`
 * are always present, because each has a defined reading for the silent case
 * (`unknown` freshness, `unknown` authority, low relevance for an unscored
 * card). Those floors matter: a card whose only present features scored 1
 * would otherwise take the top slot on lucky signals — which is exactly how a
 * text-less Drive card outranked measured evidence before `semantic` gained
 * its row. Every other feature is omitted — not zeroed — when the card carries
 * nothing to read it from.
 *
 * `exactMatch` and `focus` are present only on cards that carry an `object`:
 * a memory card cannot carry one, so scoring it 0 would park a fifth of its
 * average at zero permanently. An object-state MISS card (no `object`) is
 * demoted through its `score: 0`, not through these features.
 *
 * Two features read `relation` (#1087), because a document card may now carry
 * an object its own text NAMED and that card was still reached by similarity:
 *
 * - `exactMatch` asserts a retrieval mode, so only `relation: "is"` earns it.
 * - `focus` scores a measured miss as `0`, and only an `is` card can measure
 *   one; see {@link focusMatcher}. A `names` card that matches still scores,
 *   because a chunk naming the object the caller asked about is genuinely
 *   on-focus.
 *
 * `objectState` stays ungated by design. It is the feature this slice exists to
 * feed, and the projection's lifecycle reads the same whichever way the card
 * reached the object: a chunk about merged work is about merged work.
 *
 * Known consequence, measured. {@link weightedAverage} divides by the weights
 * the card SUPPLIED, so a card that gains a feature scored below its own mean
 * ends below an equal card that gained nothing. A card naming a `resolved`
 * pull request therefore sits below an unannotated equal whenever that card's
 * mean is above the mean of the values it gained. The drop is at most about
 * `0.07`, and about `0.10` when `focus` also scores `0.5`. That is the
 * ranker's model rather than a property of this feature; removing it needs
 * either a score for the absent case, which would be a lie, or taking
 * `objectState` out of the weighted average, which is a ranker redesign.
 */
function cardFeatures(card: EvidenceCard, { context, semantic, focus }: FeatureInputs) {
  // The bag starts empty and every feature writes itself in. A feature here is
  // PRESENT or ABSENT, never neutral, so there is no value to seed it with.
  const features: Partial<Record<EvidenceRankFeature, number>> = {};

  // Only a card that IS the object was reached by an exact reference. A card
  // that merely MENTIONS one was reached by similarity, so it earns no
  // exact-retrieval reading. Cards with no `object` get no `exactMatch` feature
  // at all: most sources cannot carry one, and an object-state MISS card is
  // already demoted through its `score: 0`.
  if (card.object?.relation === "is") features.exactMatch = 1;
  features.freshness = FRESHNESS_SCORES[card.time?.freshness ?? "unknown"];
  features.authority = AUTHORITY_SCORES[card.authority?.level ?? "unknown"];

  const semanticScore = semantic.get(card);

  // Always present: an unscored card reads as low relevance rather than
  // dropping the lead feature (see SEMANTIC_UNKNOWN_SCORE). Only a measured
  // non-match scores below it.
  features.semantic = semanticScore ?? SEMANTIC_UNKNOWN_SCORE;

  const recency = recencyScore(card, context.now);

  if (recency !== undefined) features.recency = recency;

  const priority = context.sourcePriority?.get(card.source.id);

  if (priority !== undefined && Number.isFinite(priority)) {
    features.sourcePriority = clamp01(priority);
  }

  // `stateCategory` is `StateCategory | undefined` because the card is parsed
  // against `evidenceCardSchema` at the boundary, and `OBJECT_STATE_SCORES`
  // declares a row per member, so this lookup is total without a guard.
  const stateCategory = card.object?.stateCategory;

  if (stateCategory !== undefined) features.objectState = OBJECT_STATE_SCORES[stateCategory];

  const focusScore = focus(card);

  if (focusScore !== undefined) features.focus = focusScore;

  const userModel = userModelScore(card, context.entitySignificance);

  if (userModel !== undefined) features.userModel = userModel;

  return features;
}

/** Weighted average over the features a card actually supplied. */
function weightedAverage(features: Partial<Record<EvidenceRankFeature, number>>): number {
  let weighted = 0;
  let totalWeight = 0;

  for (const feature of EVIDENCE_RANK_FEATURES) {
    const value = features[feature];

    if (value === undefined) continue;

    const weight = FEATURE_WEIGHTS[feature];

    weighted += weight * value;
    totalWeight += weight;
  }

  // Unreachable while `freshness`, `authority`, and `semantic` stay
  // always-present; it is the honest answer rather than a division by zero if
  // that changes.
  if (totalWeight === 0) return 0;

  return roundScore(weighted / totalWeight);
}

/**
 * Round a combined score to {@link SCORE_PRECISION} places. Kept local rather
 * than reusing `round3`: that helper pins 3 places for significance display,
 * while ranking needs 6 so near-ties fall through to the stable id order.
 */
function roundScore(value: number): number {
  const factor = 10 ** SCORE_PRECISION;

  return Math.round(value * factor) / factor;
}

/**
 * Normalize each source's own `score` into a comparable `[0, 1]` reading,
 * keyed by the card object itself.
 *
 * The card contract states that `score` is comparable ONLY within one source —
 * cosine similarity from the vector adapters, an exact-match confidence of `1`
 * or `0` from object-state, an arbitrary scale from a future MCP source. So the
 * normalization is per source, never global.
 *
 * Two branches, and the split is the careful part:
 *
 * - A source whose scores ALL fall in `[0, 1]` is left alone. That is already
 *   the shared convention (a similarity, a confidence), and min-max would
 *   destroy its magnitude: a source returning three near-worthless hits at
 *   `0.11`, `0.10`, `0.09` would have its best one rescaled to a perfect `1`
 *   and outrank a genuinely strong `0.9` from another source.
 * - Any other scale is min-max normalized within the source, because the
 *   numbers mean nothing to this file and only their ORDER is trustworthy. A
 *   source whose scores are all equal has no order to read, so every card gets
 *   a neutral `0.5` rather than an invented spread. By construction the best
 *   card on an uncalibrated scale reads exactly `1`: scale trust is the source
 *   capability manifest's job (#466), not this function's — see the residual
 *   risk on self-reported `score`.
 *
 * A card with no `score` gets no entry, so the caller reads it as
 * {@link SEMANTIC_UNKNOWN_SCORE} rather than dropping the lead feature. That
 * is the "ranker degrades rather than inventing a number" rule narrowed to
 * its honest shape: the ranker invents no ORDER (an unscored card claims no
 * place above a weak measured hit), but it refuses to reward the omission
 * with the mean of the card's trust signals.
 */
function normalizeSemanticScores(
  cards: readonly EvidenceCard[],
): ReadonlyMap<EvidenceCard, number> {
  const bySource = new Map<string, EvidenceCard[]>();

  for (const card of cards) {
    if (card.score === undefined || !Number.isFinite(card.score)) continue;

    const group = bySource.get(card.source.id);

    if (group === undefined) bySource.set(card.source.id, [card]);
    else group.push(card);
  }

  const normalized = new Map<EvidenceCard, number>();

  for (const group of bySource.values()) {
    // SAFETY: scores here are non-optional by construction: only cards with a
    // defined `score` contribute above, so absence never invents a number.
    const scores = group.map((card) => card.score as number);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const alreadyNormalized = min >= 0 && max <= 1;

    for (const card of group) {
      // SAFETY: same non-optional-by-construction score as the group above.
      const score = card.score as number;

      if (alreadyNormalized) normalized.set(card, score);
      else if (max === min) normalized.set(card, 0.5);
      else normalized.set(card, (score - min) / (max - min));
    }
  }

  return normalized;
}

/**
 * Exponential decay on the most recent instant the card carries.
 *
 * `occurredAt` wins when present — when the underlying event happened is what
 * "recent" means to a reader — and `observedAt` / `indexedAt` are the fallbacks
 * for a record that never declared an event time. A card with no instant at all
 * returns `undefined`: the feature is dropped, never scored as infinitely old.
 * That is the same rule the packer follows when it refuses to infer staleness
 * from a missing timestamp.
 */
function recencyScore(card: EvidenceCard, now: Date): number | undefined {
  const instant = card.time?.occurredAt ?? card.time?.observedAt ?? card.time?.indexedAt;

  if (instant === undefined) return undefined;

  const at = Date.parse(instant);

  if (!Number.isFinite(at)) return undefined;

  // A far-future instant is a dishonest or corrupt timestamp, not evidence
  // from the future. Small clock skew (<= 1 day) still reads as current inside
  // `halfLifeDecay`; anything beyond that drops the feature rather than
  // earning `recency = 1` forever (e.g. a card claiming year 3000).
  if (at > now.getTime() + MS_PER_DAY) return undefined;

  return halfLifeDecay(new Date(at), now, RECENCY_HALF_LIFE_DAYS);
}

/**
 * Exponential half-life decay of an instant, in `[0, 1]`.
 *
 * Private to the ranker. A future instant within skew tolerance is a clock
 * skew or a scheduled event, not evidence from the future: it reads as
 * current rather than letting the curve exceed 1. Far-future instants never
 * reach here — `recencyScore` drops them before the call.
 */
function halfLifeDecay(instant: Date, now: Date, halfLifeDays: number): number {
  const ageDays = (now.getTime() - instant.getTime()) / MS_PER_DAY;

  if (ageDays <= 0) return 1;

  return clamp01(0.5 ** (ageDays / halfLifeDays));
}

/**
 * The caller's declared focus (the request's exact `objects`), as far as this
 * slice can read it.
 *
 * Thread continuity is NOT met by this slice: no card carries a thread and the
 * envelope carries no conversation id. This feature reads only the caller's
 * declared exact objects — a narrower, honest signal, not a thread reading.
 *
 * It is distinct from `exactMatch`, though both read object identity. They
 * take different inputs: `exactMatch` reads the CARD (any resolved object
 * scores 1, rewarding an exact reference over similarity), while `focus`
 * reads the REQUEST (only the caller's declared objects score 1, same
 * provider 0.5, other provider 0). A request that declares no objects gives no
 * card the feature; a card with no `object` gets NO focus feature at all.
 *
 * A thread-scoped entity set is the fuller reading and lands with the ADR-0067
 * identity work (#431), which is also what will populate a card's `entities`.
 */
function focusMatcher(
  objects: readonly ContextObjectRef[] | undefined,
): (card: EvidenceCard) => number | undefined {
  if (objects === undefined || objects.length === 0) return () => undefined;

  const identities = new Set<string>();
  const providers = new Set<string>();

  for (const ref of objects) {
    providers.add(ref.provider);

    // Only an identity reference names an object outright. A key reference
    // names a KEY, and which object it resolves to is the object-state store's
    // answer, not a string this file may guess at.
    if (ref.by === "identity") {
      identities.add(`${ref.provider}:${ref.kind}:${ref.externalId}`);
    }
  }

  return (card) => {
    const object = card.object;

    // A card that carries no `object` cannot be about the caller's declared
    // focus, but most sources cannot carry one — so the feature is absent,
    // not zero.
    if (object === undefined) return undefined;

    if (identities.has(`${object.provider}:${object.kind}:${object.externalId}`)) return 1;

    // Known gap: this arm returns BEFORE the relation gate below, so a `names`
    // card that annotates a DIFFERENT object of a declared provider scores
    // 0.5 on the same reading the next comment refuses to score zero on. It
    // costs such a card about 0.03 to 0.04 against an unannotated equal.
    // Gating this arm is a separate change, not this slice.
    if (providers.has(object.provider)) return 0.5;

    // Zero is a MEASURED miss, and only an `is` card can supply one: it carries
    // the one identity the caller resolved, and that identity is not a declared
    // one. A `names` card cannot. Its object is whatever key the chunk's own
    // rendered preview happened to hold, so a non-match says the annotation
    // missed — the declared object may sit past the preview's cut, or in a
    // written form no adapter parses — never that the chunk is off-focus.
    // Absent, not zero: `weightedAverage` divides by the weights the card
    // supplied, so a zero here would demote the annotated card below the
    // unannotated one beside it on a reading the annotation cannot support.
    return object.relation === "is" ? 0 : undefined;
  };
}

/**
 * The strongest user-model weight among the entities the card is about.
 *
 * `max`, not an average: a card about one entity the user works with daily and
 * three they never see is still a card about the important one, and averaging
 * would dilute exactly the signal the feature exists to catch.
 *
 * Returns `undefined` — dropping the feature — when the card names no entity,
 * when no projection is active, or when none of its entities are in the
 * projection. All three are the same honest answer: this read has no user-model
 * opinion about this card.
 */
function userModelScore(
  card: EvidenceCard,
  significance: ReadonlyMap<string, number> | undefined,
): number | undefined {
  if (significance === undefined || significance.size === 0) return undefined;

  const entities = card.entities;

  if (entities === undefined || entities.length === 0) return undefined;

  let best: number | undefined;

  for (const entity of entities) {
    const weight = significance.get(entitySignificanceKey(entity.kind, entity.value));

    if (weight === undefined || !Number.isFinite(weight)) continue;

    const clamped = clamp01(weight);

    if (best === undefined || clamped > best) best = clamped;
  }

  return best;
}
