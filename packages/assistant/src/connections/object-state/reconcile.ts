import {
  closureCandidate,
  isBuiltInObjectStateProvider,
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
import { mcpObjectStateAdapter } from "./mcp-adapter";
import { railwayObjectStateAdapter } from "./railway-adapter";
import { vercelObjectStateAdapter } from "./vercel-adapter";
import { sentryObjectStateAdapter } from "./sentry-adapter";
import {
  objectStateStore,
  type ObjectState,
  type ObjectStateRef,
  type ObjectStateStore,
} from "./store";

/**
 * Reconciliation (ADR-0062 dispose half, #1088): resolve candidate keys to object state. Shared by
 * briefing loop reconciliation, the pre-send open-ask guard and Context Search (#1087). Adapters
 * decide which written forms name an object; this file owns resolve, precedence and closure. A key
 * that resolves to nothing, to several objects, or to a non-closing state changes nothing. Absence
 * never closes (ADR-0048-D).
 */

/** One resolved object and what its state does to an ask. */
export interface ReconciledObject<Reading extends KeyProposalReading> {
  /** The candidate key that proved this object. */
  key: CandidateKey<Reading>;
  /** Reducer-owned state. The only assertion in this result. */
  state: ObjectState;
  /**
   * The category this state would close an open ask as, else `null`. Always `null` for a reading
   * with no closure authority (`annotates`). A candidate, not a closure: a consumer that suppresses
   * on it must confirm with `closesOpenAsk`, since a `live_confirmation` kind closes nothing
   * without a live read (ADR-0103).
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

/** `satisfies` makes a registry provider without an adapter a compile error. */
const OBJECT_STATE_ADAPTERS = {
  github: githubObjectStateAdapter,
  sentry: sentryObjectStateAdapter,
  // Proposes no keys from text yet; the row keeps the table complete.
  railway: railwayObjectStateAdapter,
  // Same: no Vercel notification in the corpus to ground a grammar on (#1167).
  vercel: vercelObjectStateAdapter,
  // MCP identities come only from an owner-approved live read, never from free text.
  mcp: mcpObjectStateAdapter,
} satisfies Record<ObjectStateProvider, ObjectStateAdapter>;

/**
 * Every key the adapters propose for one subject, tagged with provider and reading. Pure and sync,
 * so a caller can keep only the keys and drop the text before the resolve.
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
 * Resolve each subject's candidate keys to object state. Subjects with nothing resolved are absent.
 * Exact keys batch per `(provider, keyKind)` and dedupe across subjects (#1087). Prefix keys stay
 * per key, because their ambiguity check has no single-query shape. Callers pass one reading per
 * call. A mixed array still closes correctly per key, but an `annotates` member makes {@link
 * firstClosingObject} refuse the whole result.
 */
export async function reconcileEvidence<Reading extends KeyProposalReading>(args: {
  userId: string;
  subjects: readonly ReconcileCandidates<Reading>[];
  /** Stop issuing queries and reject. Read-only, so partial maps are discarded. */
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

  // An exact key proves identity; a prefix is a guess. Try prefixes only for subjects with no exact
  // state, so a coincidental abbreviation cannot report the wrong object.
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
    const ref = await KEY_RESOLVERS[key.match](store, args.userId, key);

    if (!ref) return;

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
    // An exact match here ignores prefix guesses, even ones another subject resolved.
    const hasExactState = subjectHasExactState(subject);

    // Exact before prefix; stable within a rank. Dedupe by key, not object: a repo rename gives one
    // object two URL keys, and the open-ask guard maps back by key (#1082).
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
 * Closure authority for one result, decided by its reading. A reading without authority gets `null`
 * at runtime too, so a cast cannot smuggle a closing category. Uses `closureCandidate`, not
 * `closesOpenAsk`: this seam only nominates (ADR-0103).
 */
function closesAskAsFor<Reading extends KeyProposalReading>(
  key: CandidateKey<Reading>,
  state: ObjectState,
): ReconciledObject<Reading>["closesAskAs"] {
  // Same map `ClosureReading` derives from, so type and runtime agree.
  if (!readingClosesAsk(key.reading)) return null;

  const closes =
    closureCandidate(state.provider, state.kind, state.stateCategory)?.closesAskAs ?? null;

  // SAFETY: `readingClosesAsk` was true, so `Reading` is a `ClosureReading`. TS cannot narrow a
  // deferred generic.
  return closes as ReconciledObject<Reading>["closesAskAs"];
}

/** Built-in objects win whenever any resolved; MCP state is used only when none did. */
function selectReconciledObjectClass<Reading extends KeyProposalReading>(
  resolved: readonly ReconciledObject<Reading>[] | undefined,
): readonly ReconciledObject<Reading>[] {
  const builtIn = resolved?.filter((object) => isBuiltInObjectStateProvider(object.state.provider));

  if (builtIn && builtIn.length > 0) return builtIn;

  return resolved?.filter((object) => object.state.provider === "mcp") ?? [];
}

/** The authoritative object for a subject. Relevance and closure both use this rule. */
export function selectPrimaryReconciledObject<Reading extends KeyProposalReading>(
  resolved: readonly ReconciledObject<Reading>[] | undefined,
): ReconciledObject<Reading> | undefined {
  return selectReconciledObjectClass(resolved)[0];
}

/**
 * The first closure candidate in the authoritative class. Scans the whole class, so a later
 * built-in object can close. A consumer that suppresses on it must confirm with `closesOpenAsk`.
 */
export function firstClosingObject(
  resolved: readonly ReconciledObject<ClosureReading>[] | undefined,
): (ReconciledObject<ClosureReading> & { closesAskAs: LoopClosingStateCategory }) | undefined {
  return selectReconciledObjectClass(resolved).find(
    (
      object,
    ): object is ReconciledObject<ClosureReading> & { closesAskAs: LoopClosingStateCategory } =>
      object.closesAskAs !== null,
  );
}

/** Exhaustive over {@link ObjectKeyMatch}, so a new mode is a compile error. */
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

/** Exact outranks prefix. */
const MATCH_RANK = { exact: 0, prefix: 1 } satisfies Record<ObjectKeyMatch, number>;
