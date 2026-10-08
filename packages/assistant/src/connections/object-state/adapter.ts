import type { ObjectStateProvider } from "@alfred/contracts";

/**
 * Propose-side vocabulary for reconciliation (ADR-0062, #1088). Text may only propose a candidate
 * key; only the reducer-owned projection decides whether work is finished.
 */

/** `prefix` is for an abbreviated sha, which an exact lookup on the 40-hex key cannot find. */
export type ObjectKeyMatch = "exact" | "prefix";

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
  match: ObjectKeyMatch;
  /** Attached at claim time, never here. Else `keyIdentity` would merge two providers' keys. */
  provider?: never;
}

/**
 * An extracted key that an adapter claimed. The provider makes it resolvable. `reading` is
 * required, so an `annotates` result is type-distinct from an `about` one, and `reconcile.ts` reads
 * it to decide closure.
 */
export interface CandidateKey<Reading extends KeyProposalReading> extends Omit<
  ExtractedKey,
  "provider"
> {
  provider: ObjectStateProvider;
  readonly reading: Reading;
}

/**
 * Dedup key for one candidate. Match mode is part of it: exact and prefix are different lookups.
 */
export function keyIdentity(key: ExtractedKey): string {
  return [key.keyKind, key.keyValue, key.match].join("\u0000");
}

/**
 * `keyIdentity` plus provider. Not the reading: closure is decided per key, so it cannot change a
 * result.
 */
export function candidateIdentity<Reading extends KeyProposalReading>(
  key: CandidateKey<Reading>,
): string {
  const { provider, ...extracted } = key;

  return [provider, keyIdentity(extracted)].join("\u0000");
}

/** Untrusted text; both fields may be empty. */
export interface SubjectText {
  subject: string;
  content: string;
}

/**
 * One thing to reconcile (an email, a briefing body, an evidence card). Results key back on `id`.
 */
export interface ReconcileSubject {
  id: string;
  text: SubjectText;
}

/**
 * What the caller says the text is.
 * - `about`: a notification about one work object. Adapters may demand provenance, and an ambiguous
 *   reference proposes nothing, since a wrong identity drops the wrong briefing item.
 * - `mentions`: prose that names objects. The caller suppresses prose on the result, so only forms
 *   that name a work object directly count.
 * - `annotates`: evidence the caller only decorates. May propose a constituent (a commit sha names
 *   its PR). Never closes. No reading asserts state: a wrong key resolves to nothing.
 */
export type KeyProposalReading = "about" | "mentions" | "annotates";

/**
 * The only home of closure authority. {@link ClosureReading} and {@link readingClosesAsk} derive
 * from it, so editing this map is the only way to change who may close an ask.
 */
const READING_CLOSES_ASK = {
  about: true,
  mentions: true,
  annotates: false,
} as const satisfies Record<KeyProposalReading, boolean>;

/** Readings that may close an ask. A new reading is a compile error until the map declares it. */
export type ClosureReading = {
  [R in KeyProposalReading]: (typeof READING_CLOSES_ASK)[R] extends true ? R : never;
}[KeyProposalReading];

/** Runtime read of {@link READING_CLOSES_ASK}. */
export function readingClosesAsk(reading: KeyProposalReading): boolean {
  return READING_CLOSES_ASK[reading];
}

/**
 * The reading plus the provenance it needs. `about.sender` is required (maybe `null`), so omitting
 * it is a compile error, not a subject that silently proposes nothing.
 */
export type KeyProposal =
  | { reading: "about"; sender: string | null }
  | { reading: "mentions" }
  | { reading: "annotates" };

/**
 * One provider's part of reconciliation: key proposal only. The store owns state, the registry owns
 * closure policy, and `reconcile.ts` owns precedence.
 */
export interface ObjectStateAdapter {
  readonly provider: ObjectStateProvider;
  /** Canonical keys in precedence order. Pure. Unrecognized text proposes nothing. */
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[];
}
