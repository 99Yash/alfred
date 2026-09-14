import type {
  ContextObjectRef,
  EvidenceAuthorityLevel,
  EvidenceCard,
  EvidenceFreshness,
  StateCategory,
} from "@alfred/contracts";

/**
 * The deterministic evidence ranker (#427; epic #422; ADR-0101 sub-decision 7).
 *
 * Slice 1 returned cards in source-registration order and truncated the
 * combined list, so a productive later source could be dropped whole by an
 * earlier one. This file replaces that order with one cross-source ranking.
 *
 * Three properties define it:
 *
 * - **Deterministic.** Pure function, no I/O, no clock of its own — `now` is an
 *   input. Every signal it reads is already on the card. The same cards and the
 *   same context produce the same order on every call, so a ranking change is a
 *   code change, never provider weather.
 * - **No LLM reranker.** The features below are arithmetic over declared card
 *   fields. A model-based reranker is a separate, later decision; nothing here
 *   calls one.
 * - **Degrading.** A feature a card cannot supply is DROPPED from that card's
 *   weighted average, not defaulted to zero. A card with no timestamp is not
 *   punished for silence, and a read with no active ADR-0067 projection scores
 *   exactly as it did before the projection existed. Absence never invents a
 *   number — the same rule the card contract already holds itself to.
 *
 * The ranker never reads `snippet` or `note` text. It ranks on structure:
 * declared score, declared freshness, declared authority, declared object
 * state. Text is the model's job.
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
 * sum, so they need not total 1 and a card missing a feature is not penalized
 * for the missing weight.
 *
 * The ordering of the numbers is the actual decision here:
 *
 * - `semantic` leads, because a retrieval score is still the strongest single
 *   reading of "does this answer the query".
 * - `exactMatch` sits just under it so a deterministically resolved work object
 *   outranks a weak fuzzy hit, which is the tie the object-state adapter (#425)
 *   exists to win.
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
  exactMatch: 0.2,
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
 * Optional signals the boundary supplies per read. Every field is optional
 * because every one of them has a real absent case, and the ranker's contract
 * is that an absent signal drops its feature rather than defaulting it.
 */
export interface EvidenceRankContext {
  /** The instant `recency` decays from. An input, never `Date.now()` inside. */
  readonly now: Date;
  /**
   * The exact object references the caller declared on the request. They are
   * the caller's stated focus, so evidence about them is ranked up.
   */
  readonly objects?: readonly ContextObjectRef[] | undefined;
  /**
   * Per-source priority in `[0, 1]`, keyed by `ContextSource.id`.
   *
   * This is the #466 seam. The manifest declares a source's authority,
   * freshness, and cost; the boundary folds them into one priority per source
   * and passes it here. Until the manifest lands the map is empty and the
   * `sourcePriority` feature is simply absent from every card, which is the
   * same degradation path an unlisted source will take afterwards.
   */
  readonly sourcePriority?: ReadonlyMap<string, number> | undefined;
  /**
   * Per-entity user-model weight in `[0, 1]`, keyed by
   * `${identity.kind}:${identity.value}` (see {@link entitySignificanceKey}).
   *
   * Built from the ADR-0067 active projection by `user-model-signal.ts`. An
   * absent projection, an unknown entity, or a card with no entities all end in
   * the same place: no `userModel` feature on that card.
   */
  readonly entitySignificance?: ReadonlyMap<string, number> | undefined;
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
   * The features that were present, with their normalized readings. A feature
   * the card could not supply is absent from this record rather than present
   * with a zero, so a trace shows the difference between "scored badly" and
   * "could not be scored".
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

  const scored = cards.map((card, index) => {
    const features = cardFeatures(card, index, { context, semantic, focus });

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
  readonly semantic: ReadonlyMap<number, number>;
  readonly focus: (card: EvidenceCard) => number | undefined;
}

/**
 * Every feature one card can supply. A feature is omitted — not zeroed — when
 * the card carries nothing to read it from.
 *
 * `exactMatch`, `freshness`, and `authority` are always present, because each
 * has a defined reading for the silent case (no object, `unknown` freshness,
 * `unknown` authority). That floor matters: a card whose only present feature
 * scored 1 would otherwise take the top slot on one lucky signal.
 */
function cardFeatures(
  card: EvidenceCard,
  index: number,
  { context, semantic, focus }: FeatureInputs,
) {
  // The bag starts empty and every feature writes itself in. A feature here is
  // PRESENT or ABSENT, never neutral, so there is no value to seed it with.
  const features: Partial<Record<EvidenceRankFeature, number>> = {};

  // A card carrying a resolved object identity was reached by an exact
  // reference, not by similarity. An object-state MISS card carries no
  // `object` and correctly scores 0 here: the lookup happened and found
  // nothing, which is honest evidence but not a match.
  features.exactMatch = card.object === undefined ? 0 : 1;
  features.freshness = FRESHNESS_SCORES[card.time?.freshness ?? "unknown"];
  features.authority = AUTHORITY_SCORES[card.authority?.level ?? "unknown"];

  const semanticScore = semantic.get(index);

  if (semanticScore !== undefined) features.semantic = semanticScore;

  const recency = recencyScore(card, context.now);

  if (recency !== undefined) features.recency = recency;

  const priority = context.sourcePriority?.get(card.source.id);

  if (priority !== undefined && Number.isFinite(priority)) {
    features.sourcePriority = clampUnit(priority);
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

  // Unreachable while the three always-present features above stay present;
  // it is the honest answer rather than a division by zero if that changes.
  if (totalWeight === 0) return 0;

  return round(weighted / totalWeight);
}

function round(value: number): number {
  const factor = 10 ** SCORE_PRECISION;

  return Math.round(value * factor) / factor;
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Normalize each source's own `score` into a comparable `[0, 1]` reading,
 * keyed by the card's index in the input list.
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
 *   a neutral `0.5` rather than an invented spread.
 *
 * A card with no `score` gets no entry, so its `semantic` feature is absent and
 * its other features decide its place. That is the "ranker degrades rather than
 * inventing a number" rule the card contract writes down.
 */
function normalizeSemanticScores(cards: readonly EvidenceCard[]): ReadonlyMap<number, number> {
  const bySource = new Map<string, number[]>();

  for (const [index, card] of cards.entries()) {
    if (card.score === undefined) continue;

    const group = bySource.get(card.source.id);

    if (group === undefined) bySource.set(card.source.id, [index]);
    else group.push(index);
  }

  const normalized = new Map<number, number>();

  for (const indices of bySource.values()) {
    const scores = indices.map((index) => cards[index]?.score ?? 0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const alreadyNormalized = min >= 0 && max <= 1;

    for (const [position, index] of indices.entries()) {
      const score = scores[position] ?? 0;

      if (alreadyNormalized) normalized.set(index, score);
      else if (max === min) normalized.set(index, 0.5);
      else normalized.set(index, (score - min) / (max - min));
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

  return halfLifeDecay(new Date(at), now, RECENCY_HALF_LIFE_DAYS);
}

/**
 * Exponential half-life decay of an instant, in `[0, 1]`.
 *
 * Shared by the card `recency` feature and the user-model `lastSeenAt` term so
 * the two cannot drift into two curves. The half-life is a parameter because
 * the two answer different questions: how old a RECORD is, and how long ago
 * Alfred last saw an ENTITY.
 *
 * A future instant is a clock skew or a scheduled event, not evidence from the
 * future. It reads as current rather than letting the curve exceed 1.
 */
export function halfLifeDecay(instant: Date, now: Date, halfLifeDays: number): number {
  const ageDays = (now.getTime() - instant.getTime()) / MS_PER_DAY;

  if (ageDays <= 0) return 1;

  return clampUnit(0.5 ** (ageDays / halfLifeDays));
}

/**
 * The caller's declared focus (the request's exact `objects`), as far as this
 * slice can read it.
 *
 * The #427 criterion names "thread continuity". A card carries no thread and
 * the read envelope carries no conversation id, so the only stated focus
 * available today is the exact object set the caller passed. This reads that
 * set: an exact identity hit scores 1, the same provider scores 0.5, anything
 * else 0. A request that declared no objects gets NO focus feature at all,
 * rather than every card scoring 0 on a signal the caller never expressed.
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

    if (object === undefined) return 0;

    if (identities.has(`${object.provider}:${object.kind}:${object.externalId}`)) return 1;

    return providers.has(object.provider) ? 0.5 : 0;
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

    const clamped = clampUnit(weight);

    if (best === undefined || clamped > best) best = clamped;
  }

  return best;
}
