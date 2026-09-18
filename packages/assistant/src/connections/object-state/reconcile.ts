import {
  closesOpenAsk,
  type LoopClosingStateCategory,
  type ObjectStateProvider,
} from "@alfred/contracts";
import {
  candidateIdentity,
  type CandidateKey,
  type ClosureReading,
  type KeyProposal,
  type KeyProposalReading,
  type ObjectKeyMatch,
  type ObjectStateAdapter,
  readingClosesAsk,
  type ReconcileSubject,
} from "./adapter";
import { githubObjectStateAdapter } from "./github-adapter";
import { sentryObjectStateAdapter } from "./sentry-adapter";
import {
  objectStateStore,
  type ObjectState,
  type ObjectStateRef,
  type ObjectStateStore,
} from "./store";

/**
 * The one reconciliation operation (#1088) — ADR-0062's dispose half.
 *
 * Two callers ask the same question of the same projection today: the
 * briefing's loop reconciliation ("has the PR this mail is about been
 * merged?") and the pre-send open-ask guard ("does the prose ask me to act on
 * finished work?"). Before this file both of them owned their own copy of the
 * resolve, the exact-beats-prefix precedence, and the closure test, so a
 * second object shape would have landed twice. Context Search enrichment
 * (#1087) becomes the third caller; it owned no copy.
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

/** One resolved object, with what this build says its state does to an ask. */
export interface ReconciledObject<Reading extends KeyProposalReading> {
  /** The candidate key that proved this object. */
  key: CandidateKey<Reading>;
  /** Reducer-owned state. The only assertion in this result. */
  state: ObjectState;
  /**
   * The category when it closes an already-open ask about an object of this
   * kind, else `null`. It carries the narrowed category rather than a boolean
   * so a caller can record WHICH closure it saw without re-deriving it. For a
   * reading whose authority is `false` — `annotates` today — the type is
   * exactly `null`, so a direct reader of this field cannot receive a closing
   * category even after an `as` cast; that reading holds no closure authority.
   */
  closesAskAs: Reading extends ClosureReading ? LoopClosingStateCategory | null : null;
}

/** A subject's resolved objects, strongest key first. */
export type ReconcileResult<Reading extends KeyProposalReading> = ReadonlyMap<
  string,
  readonly ReconciledObject<Reading>[]
>;

/** One subject's candidate keys, as `reconcileEvidence` takes them. */
export interface ReconcileCandidates<Reading extends KeyProposalReading> {
  /** The caller's own id for the subject; the result is keyed back on it. */
  id: string;
  keys: readonly CandidateKey<Reading>[];
}

/**
 * Every adapter this build projects. Keyed by provider and `satisfies`-checked,
 * so a provider added to the registry without an adapter is a compile error
 * rather than a silently unreconciled source.
 */
const OBJECT_STATE_ADAPTERS = {
  github: githubObjectStateAdapter,
  sentry: sentryObjectStateAdapter,
} satisfies Record<ObjectStateProvider, ObjectStateAdapter>;

/**
 * Every key the registered adapters propose for one subject, tagged with the
 * provider that claimed it and the reading it was proposed under.
 *
 * Pure and synchronous, so a caller can run it inside the loop that already
 * holds the text and keep only the keys — a briefing gather never has to carry
 * a window of email bodies into the resolve phase. The reading is stamped here
 * because this seam owns it: the adapters propose written forms, not readings.
 */
export function proposeObjectKeys<Reading extends KeyProposalReading>(
  subject: ReconcileSubject,
  proposal: Extract<KeyProposal, { reading: Reading }>,
): CandidateKey<Reading>[] {
  const keys: CandidateKey<Reading>[] = [];

  for (const adapter of Object.values(OBJECT_STATE_ADAPTERS)) {
    for (const key of adapter.proposeKeys(subject, proposal)) {
      keys.push({ ...key, provider: adapter.provider, reading: proposal.reading });
    }
  }

  return keys;
}

/**
 * Resolve every subject's candidate keys to reducer-owned object state.
 *
 * Exact keys are resolved in batches — one `resolveByKeys` per
 * `(provider, keyKind)` group, plus one `getStates` over the resolved object
 * ids — and deduplicated across subjects, so a read that proposes hundreds of
 * keys costs one round trip per group instead of one per key against a pool
 * of 20 (#1087). Prefix keys stay per-key: their per-prefix `limit(2)`
 * ambiguity has no single-query shape.
 *
 * A subject with no resolvable key is absent from the result, never present
 * with an invented entry.
 *
 * "One call has one reading" is the caller's precondition, not a fact the types
 * enforce: the caller supplies one reading for the whole subject array, and a
 * mixed array compiles with `Reading` inferred as the union of its readings.
 * A mixed array does not miscarry closure — the reading is not part of
 * {@link import("./adapter").candidateIdentity}, and the seam decides closure
 * from each key's own `reading` — so per-key closure stays correct. The union
 * only widens the result: once it admits a reading with no closure authority
 * (`annotates`), {@link firstClosingObject} refuses the whole result. The result
 * is typed by the reading, and an `annotates` result carries `null` closure by
 * construction — the reading, not a comment, decides whether a caller may close
 * an ask.
 */
export async function reconcileEvidence<Reading extends KeyProposalReading>(args: {
  userId: string;
  subjects: readonly ReconcileCandidates<Reading>[];
  /**
   * When aborted, no further query is issued and the call rejects instead of
   * consuming the caller's whole budget (the context-search collect timeout).
   * The operation is read-only, so abort discards partial maps.
   */
  abortSignal?: AbortSignal;
}): Promise<ReconcileResult<Reading>> {
  const store = objectStateStore;
  const subjects = args.subjects.filter((subject) => subject.keys.length > 0);

  if (subjects.length === 0) return new Map();

  const distinct = new Map<string, CandidateKey<Reading>>();

  for (const subject of subjects) {
    for (const key of subject.keys) distinct.set(candidateIdentity(key), key);
  }

  const stateByKey = new Map<string, ObjectState>();

  const candidates = [...distinct.values()];

  // An exact key is proof of identity; a prefix key is a guess. Resolve every
  // exact candidate first and consult a prefix only for subjects where no
  // exact candidate produced a state — otherwise a coincidental abbreviation
  // can report the wrong object's title and url.
  const exactByGroup = new Map<
    string,
    { provider: CandidateKey<Reading>["provider"]; keyKind: string; keys: CandidateKey<Reading>[] }
  >();

  for (const key of candidates) {
    if (key.match !== "exact") continue;
    const groupId = [key.provider, key.keyKind].join("\0");
    const group = exactByGroup.get(groupId);

    if (group) group.keys.push(key);
    else exactByGroup.set(groupId, { provider: key.provider, keyKind: key.keyKind, keys: [key] });
  }

  const refByKey = new Map<string, ObjectStateRef>();

  for (const group of exactByGroup.values()) {
    args.abortSignal?.throwIfAborted();

    const resolved = await store.resolveByKeys(
      args.userId,
      group.provider,
      group.keyKind,
      group.keys.map((key) => key.keyValue),
    );

    for (const key of group.keys) {
      const ref = resolved.get(key.keyValue);

      // Unknown object → the subject stays as it was.
      if (ref) refByKey.set(candidateIdentity(key), ref);
    }
  }

  args.abortSignal?.throwIfAborted();
  const statesByObjectId = await store.getStates(args.userId, [...refByKey.values()]);

  for (const [identity, ref] of refByKey) {
    const state = statesByObjectId.get(ref.objectId);

    if (state) stateByKey.set(identity, state);
  }

  const resolvePrefixKey = async (key: CandidateKey<Reading>): Promise<void> => {
    // An abbreviated sha is a leading fragment of the stored key, so it
    // resolves by prefix; an ambiguous prefix resolves to nothing.
    const ref = await KEY_RESOLVERS[key.match](store, args.userId, key);

    if (!ref) return; // unknown object → the subject stays as it was

    args.abortSignal?.throwIfAborted();

    const state = await store.getState(args.userId, ref);

    if (state) stateByKey.set(candidateIdentity(key), state);
  };

  const subjectHasExactState = (subject: ReconcileCandidates<Reading>): boolean =>
    subject.keys.some((key) => key.match === "exact" && stateByKey.has(candidateIdentity(key)));

  const wantedPrefixes = new Map<string, CandidateKey<Reading>>();

  for (const subject of subjects) {
    if (subjectHasExactState(subject)) continue;

    for (const key of subject.keys) {
      if (key.match === "prefix") wantedPrefixes.set(candidateIdentity(key), key);
    }
  }

  args.abortSignal?.throwIfAborted();
  await Promise.all([...wantedPrefixes.values()].map((key) => resolvePrefixKey(key)));

  const result = new Map<string, readonly ReconciledObject<Reading>[]>();

  for (const subject of subjects) {
    const resolved: ReconciledObject<Reading>[] = [];
    const seenKeys = new Set<string>();
    // A subject whose own exact identity resolved ignores every prefix guess —
    // including a prefix another subject's lookup resolved into the shared
    // map — so a coincidental abbreviation can never shadow this subject's
    // own proof.
    const hasExactState = subjectHasExactState(subject);

    // Exact identities outrank prefix guesses. Stable within a rank: the
    // adapter proposed the keys in its own precedence order.
    // Dedup is by candidate key, not by object: two written forms can name the
    // same row (a repository rename mints a second pull_request_url key on one
    // object), and a caller that maps back by key — the open-ask guard's
    // closedByUrl — needs every key, not one survivor per object (#1082).
    for (const key of [...subject.keys].sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match])) {
      if (key.match === "prefix" && hasExactState) continue;
      const identity = candidateIdentity(key);
      const state = stateByKey.get(identity);

      if (!state || seenKeys.has(identity)) continue;
      seenKeys.add(identity);
      resolved.push({
        key,
        state,
        closesAskAs: closesAskAsFor(key, state),
      });
    }

    if (resolved.length > 0) result.set(subject.id, resolved);
  }

  return result;
}

/**
 * The closure authority of one result, decided by the reading that proposed its
 * key. This is the one place the conditional {@link ReconciledObject} field is
 * laundered: a reading the authority map declares `false` writes `null` at
 * runtime as well as in the type, so an `as` cast that smuggles such a result
 * into a closure reader still carries no closing category.
 */
function closesAskAsFor<Reading extends KeyProposalReading>(
  key: CandidateKey<Reading>,
  state: ObjectState,
): ReconciledObject<Reading>["closesAskAs"] {
  // The same map `ClosureReading` derives from, read at runtime, so the field's
  // type and this branch cannot disagree about which reading may close.
  if (!readingClosesAsk(key.reading)) return null;

  const closes = closesOpenAsk(state.provider, state.kind, state.stateCategory);

  // SAFETY: `readingClosesAsk` returned true, so `Reading` is one of
  // `ClosureReading` and the field type admits `LoopClosingStateCategory | null`.
  // TypeScript cannot narrow a deferred `Reading` from a runtime check, so the
  // cast restates what the map already decided.
  return closes as ReconciledObject<Reading>["closesAskAs"];
}

/** The first resolved object whose state closes an open ask, if any. */
export function firstClosingObject(
  resolved: readonly ReconciledObject<ClosureReading>[] | undefined,
): (ReconciledObject<ClosureReading> & { closesAskAs: LoopClosingStateCategory }) | undefined {
  return resolved?.find(
    (
      object,
    ): object is ReconciledObject<ClosureReading> & { closesAskAs: LoopClosingStateCategory } =>
      object.closesAskAs !== null,
  );
}

/**
 * Resolver per match mode. Exhaustive over {@link ObjectKeyMatch}, so a third
 * mode is a compile error here instead of a silent exact lookup.
 */
const KEY_RESOLVERS = {
  exact: (store: ObjectStateStore, userId: string, key: CandidateKey<KeyProposalReading>) =>
    store.resolveByKey(userId, key.provider, key.keyKind, key.keyValue),
  prefix: (store: ObjectStateStore, userId: string, key: CandidateKey<KeyProposalReading>) =>
    store.resolveByKeyPrefix(userId, key.provider, key.keyKind, key.keyValue),
} satisfies Record<
  ObjectKeyMatch,
  (
    store: ObjectStateStore,
    userId: string,
    key: CandidateKey<KeyProposalReading>,
  ) => Promise<Awaited<ReturnType<ObjectStateStore["resolveByKey"]>>>
>;

/** Exact identities outrank prefix guesses. Exhaustive for the same reason. */
const MATCH_RANK = { exact: 0, prefix: 1 } satisfies Record<ObjectKeyMatch, number>;
