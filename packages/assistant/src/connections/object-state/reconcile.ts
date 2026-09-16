import {
  closesOpenAsk,
  type LoopClosingStateCategory,
  type ObjectStateProvider,
} from "@alfred/contracts";
import {
  candidateIdentity,
  type CandidateKey,
  type KeyProposalReading,
  type ObjectKeyMatch,
  type ObjectStateAdapter,
  type ReconcileSubject,
} from "./adapter";
import { githubObjectStateAdapter } from "./github-adapter";
import { objectStateStore, type ObjectState, type ObjectStateStore } from "./store";

/**
 * The one reconciliation operation (#1088) — ADR-0062's dispose half.
 *
 * Three callers ask the same question of the same projection: the briefing's
 * loop reconciliation ("has the PR this mail is about been merged?"), the
 * pre-send open-ask guard ("does the prose ask me to act on finished work?"),
 * and Context Search enrichment ("what became of the work this document
 * names?"). Before this file each of them owned its own copy of the resolve,
 * the exact-beats-prefix precedence, and the closure test, so a fourth
 * provider or a second object shape would have landed three times.
 *
 * What is generic and lives here:
 *   - resolving a candidate key to an object, exactly or by prefix;
 *   - the precedence between an exact identity and a prefix guess;
 *   - deduplicating keys across subjects so one lookup serves many;
 *   - reading closure off the registry's per-KIND policy.
 *
 * What is not, and lives in an adapter: which written forms name one of a
 * provider's objects, and what the canonical value of each one is.
 *
 * The honesty contract is unchanged and is what makes the seam safe: a key
 * that resolves to nothing, to more than one object, or to a state its kind
 * does not treat as closing leaves the subject alone. Absence never closes
 * (ADR-0048-D).
 */

/**
 * The read surface reconciliation needs. Narrower than `ObjectStateStore` so
 * this operation cannot write, and so a caller can drive it against a fake.
 */
export type ObjectStateResolver = Pick<
  ObjectStateStore,
  "resolveByKey" | "resolveByKeyPrefix" | "getState"
>;

/** One resolved object, with what this build says its state does to an ask. */
export interface ReconciledObject {
  /** The candidate key that proved this object. */
  key: CandidateKey;
  /** Reducer-owned state. The only assertion in this result. */
  state: ObjectState;
  /**
   * The category when it closes an already-open ask about an object of this
   * kind, else `null`. It carries the narrowed category rather than a boolean
   * so a caller can record WHICH closure it saw without re-deriving it.
   */
  closesAskAs: LoopClosingStateCategory | null;
}

/** A subject's resolved objects, strongest key first. */
export type ReconcileResult = ReadonlyMap<string, readonly ReconciledObject[]>;

/** One subject's candidate keys, as `reconcileEvidence` takes them. */
export interface ReconcileCandidates {
  /** The caller's own id for the subject; the result is keyed back on it. */
  id: string;
  keys: readonly CandidateKey[];
}

/**
 * Every adapter this build projects. Keyed by provider and `satisfies`-checked,
 * so a provider added to the registry without an adapter is a compile error
 * rather than a silently unreconciled source.
 */
const OBJECT_STATE_ADAPTERS = {
  github: githubObjectStateAdapter,
} satisfies Record<ObjectStateProvider, ObjectStateAdapter>;

/**
 * Every key the registered adapters propose for one subject, tagged with the
 * provider that claimed it.
 *
 * Pure and synchronous, so a caller can run it inside the loop that already
 * holds the text and keep only the keys — a briefing gather never has to carry
 * a window of email bodies into the resolve phase.
 */
export function proposeObjectKeys(
  subject: ReconcileSubject,
  reading: KeyProposalReading,
): CandidateKey[] {
  const keys: CandidateKey[] = [];

  for (const adapter of Object.values(OBJECT_STATE_ADAPTERS)) {
    for (const key of adapter.proposeKeys(subject, reading)) {
      keys.push({ ...key, provider: adapter.provider });
    }
  }

  return keys;
}

/**
 * Resolve every subject's candidate keys to reducer-owned object state.
 *
 * Keys are resolved in parallel and deduplicated across subjects: at
 * single-user scale a batch holds a handful of candidates, and each lookup
 * reads one index.
 *
 * A subject with no resolvable key is absent from the result, never present
 * with an invented entry.
 */
export async function reconcileEvidence(args: {
  userId: string;
  subjects: readonly ReconcileCandidates[];
  store?: ObjectStateResolver;
}): Promise<ReconcileResult> {
  const store = args.store ?? objectStateStore;
  const subjects = args.subjects.filter((subject) => subject.keys.length > 0);

  if (subjects.length === 0) return new Map();

  const distinct = new Map<string, CandidateKey>();

  for (const subject of subjects) {
    for (const key of subject.keys) distinct.set(candidateIdentity(key), key);
  }

  const stateByKey = new Map<string, ObjectState>();

  const resolveKey = async (key: CandidateKey): Promise<void> => {
    // An abbreviated sha is a leading fragment of the stored key, so it
    // resolves by prefix; an ambiguous prefix resolves to nothing.
    const ref = await KEY_RESOLVERS[key.match](store, args.userId, key);

    if (!ref) return; // unknown object → the subject stays as it was
    const state = await store.getState(args.userId, ref);

    if (state) stateByKey.set(candidateIdentity(key), state);
  };

  const candidates = [...distinct.values()];

  // An exact key is proof of identity; a prefix key is a guess. Resolve every
  // exact candidate first and consult a prefix only for subjects where no
  // exact candidate produced a state — otherwise a coincidental abbreviation
  // can report the wrong object's title and url.
  await Promise.all(
    candidates.filter((key) => key.match === "exact").map((key) => resolveKey(key)),
  );

  const subjectHasExactState = (subject: ReconcileCandidates): boolean =>
    subject.keys.some((key) => key.match === "exact" && stateByKey.has(candidateIdentity(key)));

  const wantedPrefixes = new Map<string, CandidateKey>();

  for (const subject of subjects) {
    if (subjectHasExactState(subject)) continue;

    for (const key of subject.keys) {
      if (key.match === "prefix") wantedPrefixes.set(candidateIdentity(key), key);
    }
  }

  await Promise.all([...wantedPrefixes.values()].map((key) => resolveKey(key)));

  const result = new Map<string, readonly ReconciledObject[]>();

  for (const subject of subjects) {
    const resolved: ReconciledObject[] = [];
    const seenObjects = new Set<string>();

    // Exact identities outrank prefix guesses, so a resolved prefix shared
    // with another subject can never shadow this subject's own proof. Stable
    // within a rank: the adapter proposed the keys in its own precedence order.
    for (const key of [...subject.keys].sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match])) {
      const state = stateByKey.get(candidateIdentity(key));

      if (!state || seenObjects.has(state.objectId)) continue;
      seenObjects.add(state.objectId);
      resolved.push({
        key,
        state,
        closesAskAs: closesOpenAsk(state.provider, state.kind, state.stateCategory)
          ? state.stateCategory
          : null,
      });
    }

    if (resolved.length > 0) result.set(subject.id, resolved);
  }

  return result;
}

/** The first resolved object whose state closes an open ask, if any. */
export function firstClosingObject(
  resolved: readonly ReconciledObject[] | undefined,
): (ReconciledObject & { closesAskAs: LoopClosingStateCategory }) | undefined {
  return resolved?.find(
    (object): object is ReconciledObject & { closesAskAs: LoopClosingStateCategory } =>
      object.closesAskAs !== null,
  );
}

/**
 * Resolver per match mode. Exhaustive over {@link ObjectKeyMatch}, so a third
 * mode is a compile error here instead of a silent exact lookup.
 */
const KEY_RESOLVERS = {
  exact: (store: ObjectStateResolver, userId: string, key: CandidateKey) =>
    store.resolveByKey(userId, key.provider, key.keyKind, key.keyValue),
  prefix: (store: ObjectStateResolver, userId: string, key: CandidateKey) =>
    store.resolveByKeyPrefix(userId, key.provider, key.keyKind, key.keyValue),
} satisfies Record<
  ObjectKeyMatch,
  (
    store: ObjectStateResolver,
    userId: string,
    key: CandidateKey,
  ) => Promise<Awaited<ReturnType<ObjectStateResolver["resolveByKey"]>>>
>;

/** Exact identities outrank prefix guesses. Exhaustive for the same reason. */
const MATCH_RANK = { exact: 0, prefix: 1 } satisfies Record<ObjectKeyMatch, number>;
