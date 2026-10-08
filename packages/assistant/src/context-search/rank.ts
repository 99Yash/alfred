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
 * Deterministic cross-source evidence ranker (ADR-0101 sub-decisions 7 and 12).
 * Pure, no model call, `now` is an input. An absent signal drops its feature
 * from the weighted average. `freshness`, `authority`, and `semantic` are never
 * absent. The ranker never reads `snippet` or `note`.
 */

/** Ranking features, each normalized to `[0, 1]`, higher ranks higher. */
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
 * Weights in a weighted average, so they need not sum to 1.
 * `semantic` leads. `authority` is a trust prior, so it stays mid-weight.
 * The rest are tie-breakers: each is often absent, and a large weight would
 * rank cards by which features they happen to carry.
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

/** Smooth decay, so a threshold cannot split two records one second apart. */
const RECENCY_HALF_LIFE_DAYS = 14;

// Unit conversion only. Calendar-day math belongs on `@alfred/assistant/time` keys.
const MS_PER_DAY = 86_400_000;

/** Round before comparing, so float noise cannot break a real tie. The `id` order breaks it. */
const SCORE_PRECISION = 6;

/**
 * How current Alfred's copy is. `stale` is a source's own admission,
 * so it scores below `unknown`.
 */
const FRESHNESS_SCORES = {
  live: 1,
  ingested: 0.6,
  unknown: 0.35,
  stale: 0.1,
} as const satisfies Record<EvidenceFreshness, number>;

/** `unknown` sits just above `low`: silence earns no promotion and no penalty. */
const AUTHORITY_SCORES = {
  high: 1,
  medium: 0.65,
  unknown: 0.35,
  low: 0.3,
} as const satisfies Record<EvidenceAuthorityLevel, number>;

/** Cost only breaks ties: prefer a local read. `unknown` sits above `remote`. */
const COST_SCORES = {
  local: 1,
  metered: 0.6,
  unknown: 0.5,
  remote: 0.35,
} as const satisfies Record<SourceCostClass, number>;

/**
 * `semantic` for a card whose source measured no score (Drive, #1078).
 * Dropping the feature let trust signals alone promote a text-less card.
 * Sits above an explicit `score: 0` and below the `unknown` trust rows.
 */
const SEMANTIC_UNKNOWN_SCORE = 0.3;

/** Authority leads: only it says whether the evidence is right. */
const MANIFEST_PRIORITY_WEIGHTS = {
  authority: 0.6,
  freshness: 0.25,
  cost: 0.15,
} as const satisfies Record<keyof Pick<SourceManifest, "authority" | "freshness" | "cost">, number>;

const MANIFEST_PRIORITY_TOTAL_WEIGHT =
  MANIFEST_PRIORITY_WEIGHTS.authority +
  MANIFEST_PRIORITY_WEIGHTS.freshness +
  MANIFEST_PRIORITY_WEIGHTS.cost;

/**
 * Fold a manifest into one `[0, 1]` source priority (ADR-0101 sub-decision 13).
 * An undeclared axis scores `unknown`, and the divisor is the fixed total,
 * so omitting an axis cannot raise the result.
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

  return (
    (authority * MANIFEST_PRIORITY_WEIGHTS.authority +
      freshness * MANIFEST_PRIORITY_WEIGHTS.freshness +
      cost * MANIFEST_PRIORITY_WEIGHTS.cost) /
    MANIFEST_PRIORITY_TOTAL_WEIGHT
  );
}

/**
 * Relevance of a lifecycle bucket, not closure policy. Do not call
 * `closesOpenAsk` / `evidenceObjectClosesAsk` here.
 * `failed` ranks second because a failure is usually the alert.
 */
const OBJECT_STATE_SCORES = {
  active: 1,
  failed: 0.7,
  resolved: 0.45,
  abandoned: 0.25,
} as const satisfies Record<StateCategory, number>;

/** Per-read signals. An absent field drops its feature. */
export interface EvidenceRankContext {
  /** The instant `recency` decays from. Never read `Date.now()` inside. */
  readonly now: Date;
  /** The caller's declared objects. Evidence about them ranks higher. */
  readonly objects?: readonly ContextObjectRef[];
  /** `[0, 1]` priority per `ContextSource.id`, from {@link sourcePriorityFromManifest}. */
  readonly sourcePriority?: ReadonlyMap<string, number>;
  /**
   * `[0, 1]` weight per entity, keyed by {@link entitySignificanceKey} (#431).
   * No caller passes this yet, so `userModel` is always absent.
   */
  readonly entitySignificance?: ReadonlyMap<string, number>;
}

/**
 * One card's ranking, for traces and tests. Kept off `EvidenceCard` so the
 * packer can never render it into a prompt.
 */
export interface EvidenceRanking {
  readonly cardId: string;
  readonly sourceId: string;
  /** Rounded to {@link SCORE_PRECISION}. */
  readonly score: number;
  /** Absent means "could not be scored", which differs from a zero. */
  readonly features: Readonly<Partial<Record<EvidenceRankFeature, number>>>;
}

export interface RankedEvidence {
  readonly evidence: readonly EvidenceCard[];
  readonly ranking: readonly EvidenceRanking[];
}

/** The one spelling of the `entitySignificance` key. The value is already canonical. */
export function entitySignificanceKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

/**
 * Rank cards from all sources into one order. Ties break on `id`.
 * The caller truncates after ranking, so a strong card from a late source survives.
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

  // Card ids are reproducible, so the id tie-break gives the same order on every run.
  scored.sort((a, b) => b.ranking.score - a.ranking.score || compareIds(a.card.id, b.card.id));

  return {
    evidence: scored.map((entry) => entry.card),
    ranking: scored.map((entry) => entry.ranking),
  };
}

/** Code-unit order. `localeCompare` varies with ICU data across machines. */
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
 * The features one card supplies. Missing features are omitted, not zeroed.
 * `exactMatch` needs `relation: "is"` (#1087). `objectState` ignores relation.
 *
 * Known effect: the average divides by supplied weights, so a gained feature
 * below the card's mean lowers its score. A card that names a `resolved` PR
 * can fall up to about 0.09 below an equal card without it.
 */
function cardFeatures(card: EvidenceCard, { context, semantic, focus }: FeatureInputs) {
  const features: Partial<Record<EvidenceRankFeature, number>> = {};

  // A card that only names the object was reached by similarity, not by reference.
  if (card.object?.relation === "is") features.exactMatch = 1;
  features.freshness = FRESHNESS_SCORES[card.time?.freshness ?? "unknown"];
  features.authority = AUTHORITY_SCORES[card.authority?.level ?? "unknown"];

  const semanticScore = semantic.get(card);

  features.semantic = semanticScore ?? SEMANTIC_UNKNOWN_SCORE;

  const recency = recencyScore(card, context.now);

  if (recency !== undefined) features.recency = recency;

  const priority = context.sourcePriority?.get(card.source.id);

  if (priority !== undefined && Number.isFinite(priority)) {
    features.sourcePriority = clamp01(priority);
  }

  const stateCategory = card.object?.stateCategory;

  if (stateCategory !== undefined) features.objectState = OBJECT_STATE_SCORES[stateCategory];

  const focusScore = focus(card);

  if (focusScore !== undefined) features.focus = focusScore;

  const userModel = userModelScore(card, context.entitySignificance);

  if (userModel !== undefined) features.userModel = userModel;

  return features;
}

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

  // Unreachable while three features are always present.
  if (totalWeight === 0) return 0;

  return roundScore(weighted / totalWeight);
}

/** Not `round3`: ranking needs 6 places so near-ties reach the id order. */
function roundScore(value: number): number {
  const factor = 10 ** SCORE_PRECISION;

  return Math.round(value * factor) / factor;
}

/**
 * Normalize `score` per source, because it is comparable only within one source.
 * Scores already in `[0, 1]` stay as they are: min-max would turn a weak best
 * hit into a perfect 1. Other scales get min-max, or 0.5 when all are equal.
 * An unscored card gets no entry.
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
    // SAFETY: only cards with a defined `score` enter a group.
    const scores = group.map((card) => card.score as number);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const alreadyNormalized = min >= 0 && max <= 1;

    for (const card of group) {
      // SAFETY: only cards with a defined `score` enter a group.
      const score = card.score as number;

      if (alreadyNormalized) normalized.set(card, score);
      else if (max === min) normalized.set(card, 0.5);
      else normalized.set(card, (score - min) / (max - min));
    }
  }

  return normalized;
}

/** Decay from `occurredAt`, else `observedAt`, else `indexedAt`. No instant drops the feature. */
function recencyScore(card: EvidenceCard, now: Date): number | undefined {
  const instant = card.time?.occurredAt ?? card.time?.observedAt ?? card.time?.indexedAt;

  if (instant === undefined) return undefined;

  const at = Date.parse(instant);

  if (!Number.isFinite(at)) return undefined;

  // More than a day ahead is a corrupt timestamp, not clock skew.
  if (at > now.getTime() + MS_PER_DAY) return undefined;

  return halfLifeDecay(new Date(at), now, RECENCY_HALF_LIFE_DAYS);
}

/** A future instant (skew or a scheduled event) reads as 1. */
function halfLifeDecay(instant: Date, now: Date, halfLifeDays: number): number {
  const ageDays = (now.getTime() - instant.getTime()) / MS_PER_DAY;

  if (ageDays <= 0) return 1;

  return clamp01(0.5 ** (ageDays / halfLifeDays));
}

/**
 * Score a card against the request's declared objects: same identity 1,
 * same provider 0.5, other 0. No declared objects, or no card `object`, drops
 * the feature. This is not thread continuity: cards carry no thread.
 */
function focusMatcher(
  objects: readonly ContextObjectRef[] | undefined,
): (card: EvidenceCard) => number | undefined {
  if (objects === undefined || objects.length === 0) return () => undefined;

  const identities = new Set<string>();
  const providers = new Set<string>();

  for (const ref of objects) {
    providers.add(ref.provider);

    // A key reference resolves through the object-state store, so do not guess its object.
    if (ref.by === "identity") {
      identities.add(`${ref.provider}:${ref.kind}:${ref.externalId}`);
    }
  }

  return (card) => {
    const object = card.object;

    if (object === undefined) return undefined;

    if (identities.has(`${object.provider}:${object.kind}:${object.externalId}`)) return 1;

    // Known gap: this runs before the relation gate, so a `names` card for
    // another object of a declared provider still scores 0.5.
    if (providers.has(object.provider)) return 0.5;

    // Only an `is` card can measure a miss. A `names` miss may only mean the
    // preview cut off the declared object, so it drops the feature.
    return object.relation === "is" ? 0 : undefined;
  };
}

/** Highest weight among the card's entities. An average would dilute the one that matters. */
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
