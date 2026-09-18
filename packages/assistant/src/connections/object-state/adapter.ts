import type { ObjectStateProvider } from "@alfred/contracts";

/**
 * The provider-agnostic half of object-state reconciliation (#1088).
 *
 * ADR-0062's load-bearing invariant is propose / dispose: text may only
 * PROPOSE a candidate key, and only the reducer-owned projection may DISPOSE
 * of the question "is this work finished". This file owns the propose side's
 * vocabulary — what a candidate key is, what a subject is, and what a provider
 * adapter must supply — so the two halves can live in different files without
 * either one restating the other's shape.
 *
 * It is types and two pure helpers. The resolve half is `reconcile.ts`, the
 * GitHub adapter is `github-adapter.ts`, and this file imports neither —
 * `reconcile.ts` wires the adapters to the resolve operation.
 */

/**
 * How the store must compare a candidate value against the stored key. `prefix`
 * exists for an abbreviated sha: the value is a leading fragment of the stored
 * 40-hex key, so an exact lookup can never find it.
 */
export type ObjectKeyMatch = "exact" | "prefix";

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
  match: ObjectKeyMatch;
  /**
   * Never present on an extracted key: the provider is what makes the key
   * resolvable, so it is attached at claim time ({@link CandidateKey}), not
   * at extraction. Without this, `keyIdentity` accepts a `CandidateKey` and
   * silently collapses two providers' keys into one dedup entry.
   */
  provider?: never;
}

/**
 * An extracted key once an adapter has claimed it. The provider is what makes
 * the key resolvable — `head_sha` means nothing without the projection it is
 * keyed in — so the reconcile operation carries it rather than taking one
 * provider for a whole batch.
 *
 * The {@link KeyProposalReading} a key was proposed under is a REQUIRED
 * structural member, never absent and never defaulted. It is what makes an
 * `annotates` result type-distinct from an `about` one, so a closure reader
 * that accepts the strongest reading cannot be handed the weakest. It is real
 * data rather than a phantom: `reconcile.ts` reads it to decide whether a
 * result may carry a closing category.
 */
export interface CandidateKey<Reading extends KeyProposalReading> extends Omit<
  ExtractedKey,
  "provider"
> {
  provider: ObjectStateProvider;
  /** Which reading proposed this key. Never absent, never defaulted. */
  readonly reading: Reading;
}

/**
 * Map key for one candidate. The match mode belongs in it: the same value read
 * exactly and read as a prefix are two different lookups. Owned here beside
 * {@link ExtractedKey} so a fourth field cannot silently collapse two
 * candidates in a consumer's dedup map.
 */
export function keyIdentity(key: ExtractedKey): string {
  return [key.keyKind, key.keyValue, key.match].join("\u0000");
}

/**
 * The same identity across providers, for a batch that spans more than one.
 * The reading is deliberately not part of the identity: one `reconcileEvidence`
 * call carries one reading for all of its subjects, so two keys can never
 * differ by reading within a single dedup map.
 */
export function candidateIdentity<Reading extends KeyProposalReading>(
  key: CandidateKey<Reading>,
): string {
  const { provider, ...extracted } = key;

  return [provider, keyIdentity(extracted)].join("\u0000");
}

/** The text a subject carries. Both halves are required strings (possibly empty) and both are untrusted. */
export interface SubjectText {
  subject: string;
  content: string;
}

/**
 * One thing a caller wants reconciled: an email, a composed briefing body, an
 * evidence card. `id` is the caller's own — a document id, a card id — and the
 * reconcile result is keyed back on it.
 */
export interface ReconcileSubject {
  id: string;
  text: SubjectText;
}

/**
 * What the caller claims the text IS, which decides how an adapter reads it.
 *
 * - `about` — the text is a notification about ONE work object (a GitHub
 *   Actions failure mail, a review request). The adapter may demand provenance
 *   before it proposes anything, and an ambiguous reference proposes nothing:
 *   a wrong identity here would drop the wrong item from a briefing.
 * - `mentions` — the text merely NAMES work objects (composed briefing prose).
 *   Every named object is proposed, provenance is not claimed, and the caller
 *   SUPPRESSES prose on the result. Suppression removes a sentence a human
 *   would otherwise read, so the reading stays narrow: only a written form
 *   that names a work object directly counts.
 * - `annotates` — the text is evidence the caller ALREADY holds and will
 *   DECORATE (an indexed document chunk). The caller drops nothing, suppresses
 *   nothing, and closes no loop, so an adapter may also propose an identifier
 *   for a CONSTITUENT of a work object — a commit sha names the pull request
 *   that carries it. A wrong proposal costs one absent annotation.
 *
 * Every reading is equally safe against state, because none of them asserts
 * state: a wrong or hallucinated key resolves to nothing and closes nothing.
 * They differ only in what the caller DOES with a resolution.
 *
 * A reading now rides in the RESULT type, not only in the proposal:
 * {@link import("./reconcile").proposeObjectKeys} stamps it onto every
 * {@link CandidateKey}, and `reconcileEvidence` propagates it as a type
 * parameter. A value produced under `annotates` therefore cannot reach a
 * closure reader, which accepts only {@link ClosureReading}.
 */
export type KeyProposalReading = "about" | "mentions" | "annotates";

/**
 * Whether a reading's caller may close an already-open ask on a resolution.
 * `about` drops the item, `mentions` suppresses the prose, and `annotates` only
 * decorates a card — it holds no closure authority by design.
 */
const READING_CLOSES_ASK = {
  about: true,
  mentions: true,
  annotates: false,
} as const satisfies Record<KeyProposalReading, boolean>;

/**
 * The readings whose caller may read closure off a reconciled result. Derived
 * from {@link READING_CLOSES_ASK}, so adding a fourth reading is a compile
 * error until its closure authority is declared.
 */
export type ClosureReading = {
  [R in KeyProposalReading]: (typeof READING_CLOSES_ASK)[R] extends true ? R : never;
}[KeyProposalReading];

/**
 * What the caller asks an adapter to read, with the provenance the reading
 * demands folded in. `about` carries its sender because the adapter gates on
 * it: the field is required (possibly `null`) so a caller that omits it is a
 * compile error rather than a subject that silently proposes nothing forever.
 * `mentions` and `annotates` claim no provenance. It is provenance, never
 * state. The reading also selects the {@link CandidateKey} parameter the
 * proposal mints, so the caller's authority is carried by the result type.
 */
export type KeyProposal =
  | { reading: "about"; sender: string | null }
  | { reading: "mentions" }
  | { reading: "annotates" };

/**
 * One provider's irreducible half of reconciliation.
 *
 * It owns key PROPOSAL (which written forms name one of its objects, and what
 * the canonical value of each one is) and nothing else. State, closure policy,
 * and the exact-beats-prefix precedence are generic: the store asserts state,
 * the registry's per-kind {@link import("@alfred/contracts").ObjectKindDef}
 * declares closure, and `reconcile.ts` owns precedence. A second provider is
 * therefore one adapter file plus its registry entry and reducer — not a
 * second copy of the reconciliation.
 */
export interface ObjectStateAdapter {
  readonly provider: ObjectStateProvider;
  /**
   * Every key this subject's text proposes under `proposal`, canonical and in
   * precedence order. Pure, deterministic, and free to return nothing — an
   * adapter that does not recognize the text proposes nothing rather than
   * guessing.
   */
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[];
}
