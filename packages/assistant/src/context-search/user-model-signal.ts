import { toMessage, type EvidenceCard, type EvidenceEntityRef } from "@alfred/contracts";
import { userModelReader } from "@alfred/assistant/knowledge";
import { entitySignificanceKey, halfLifeDecay } from "./rank";

/**
 * The optional user-model ranking signal (#427; ADR-0067).
 *
 * The ranker takes per-entity weights as data so it stays a pure function. This
 * file is the one place that turns the ADR-0067 ACTIVE projection into those
 * weights, and it is built to disappear quietly:
 *
 * - No active projection pointer → no signal. A user who has never had a
 *   completed, activated projection run ranks exactly as they did before this
 *   slice.
 * - No card names an entity → no read at all. Not one query is issued, so the
 *   signal costs nothing on the reads that cannot use it. That is today's
 *   normal case: no adapter fills `EvidenceCard.entities` yet, and the field is
 *   populated by the identity work in #431.
 * - The projection read throws → no signal. A ranking input must never be able
 *   to fail a search; the boundary's contract is that absence is reported, not
 *   escalated.
 *
 * It reads the projection and never writes it. `userModelReader` is the only
 * access path (ADR-0067 D13), so this file cannot read a mixed-version
 * projection even by accident.
 */

/**
 * Weight given to an entity purely for existing in the active projection.
 *
 * The remainder is the recency term below. The split says what the signal
 * actually claims: "Alfred has a profile for this entity" is most of the
 * information, and "Alfred saw them lately" refines it. Deliberately NOT a
 * significance score — `significance_components` is time-invariant and its
 * final reading is `base(components) * recency(asOf)`, a formula the user-model
 * projection owns (ADR-0067 D6). Re-deriving it here would put a second,
 * drifting copy of that formula in a ranker.
 */
const KNOWN_ENTITY_WEIGHT = 0.5;

/** Half-life of the `lastSeenAt` term, in days. */
const LAST_SEEN_HALF_LIFE_DAYS = 30;

/**
 * Per-entity weights for {@link EvidenceRankContext.entitySignificance}, or
 * `undefined` when this read has no user-model opinion at all.
 *
 * `undefined` and an empty map mean the same thing to the ranker; `undefined`
 * is returned for the no-projection and failed-read paths so a caller logging
 * the signal can tell "no projection" from "a projection that knew none of
 * these entities".
 */
export async function buildEntitySignificance(
  userId: string,
  cards: readonly EvidenceCard[],
  now: Date,
): Promise<ReadonlyMap<string, number> | undefined> {
  const identities = collectIdentities(cards);

  if (identities.length === 0) return undefined;

  try {
    const reader = userModelReader(userId);
    const active = await reader.getActivePointer();

    if (active === null) return undefined;

    // One batched read for the whole identity set, not one query per
    // identity: the set is bounded by the request envelope (at most
    // `CONTEXT_SEARCH_MAX_LIMIT` cards × 50 entities each), and every
    // distinct identity is looked up, so which entities get a weight never
    // depends on card order.
    const profiles = await reader.listProfilesByIdentities(identities);
    const weights = new Map<string, number>();

    for (const identity of identities) {
      const profile = profiles.get(entitySignificanceKey(identity.kind, identity.value));

      if (profile === undefined) continue;

      weights.set(
        entitySignificanceKey(identity.kind, identity.value),
        entityWeight(profile.lastSeenAt, now),
      );
    }

    return weights;
  } catch (error) {
    console.warn(
      `[context-search] user-model ranking signal unavailable for user=${userId}: ${toMessage(error)}`,
    );

    return undefined;
  }
}

/**
 * The distinct identities named across the cards.
 *
 * Every distinct identity is returned — there is no lookup cap, so the set
 * never depends on card (registration) order. The caller resolves the whole
 * set in one batched read.
 *
 * A card's entity ref derives from `identityRefSchema`, so `value` is already
 * canonical for its `kind` and two spellings of the same identity cannot reach
 * here as two entries.
 */
function collectIdentities(
  cards: readonly EvidenceCard[],
): readonly Pick<EvidenceEntityRef, "kind" | "value">[] {
  const seen = new Set<string>();
  const identities: Pick<EvidenceEntityRef, "kind" | "value">[] = [];

  for (const card of cards) {
    for (const entity of card.entities ?? []) {
      const key = entitySignificanceKey(entity.kind, entity.value);

      if (seen.has(key)) continue;

      seen.add(key);
      identities.push({ kind: entity.kind, value: entity.value });
    }
  }

  return identities;
}

/**
 * A known entity's weight: the flat known-entity term, plus a decayed
 * `lastSeenAt` term. A profile with no `lastSeenAt` keeps the flat term alone —
 * never seen is not the same as seen long ago, and only the second deserves the
 * decay.
 */
function entityWeight(lastSeenAt: Date | null, now: Date): number {
  if (lastSeenAt === null) return KNOWN_ENTITY_WEIGHT;

  const recency = halfLifeDecay(lastSeenAt, now, LAST_SEEN_HALF_LIFE_DAYS);

  return KNOWN_ENTITY_WEIGHT + (1 - KNOWN_ENTITY_WEIGHT) * recency;
}
