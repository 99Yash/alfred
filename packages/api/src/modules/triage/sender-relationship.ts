/**
 * Sender-relationship resolver (ADR-0059 + amendment 2026-06-16) — the
 * directional triage observation that fixes failure A (a cold inbound minting a
 * "reply to X" todo). It renders the live graph signals about a *human* sender
 * as ONE line of observation prose fed to the cheap classifier — NOT a typed
 * value anything branches on. The cheap model reads the line and judges the
 * stake (rubric 16b), bounded by "never infer a relationship beyond the block".
 *
 * Signals, all already on the sender's `entities` row (passive team-graph
 * capture, P4a):
 *   - the **precomputed** significance scalar, bucketed to a word
 *     (`strong`/`moderate`/`weak`) — never recomputed here,
 *   - the reciprocity shape (two-way / outbound-only / one-way inbound),
 *   - same-org-domain (read straight from the stored significance components),
 *   - the user's own role from `user_facts` (`job_title`/`employer`).
 *
 * A human sender with no graph row renders `no prior contact on record`, so the
 * rubric degrades to exactly today's intrinsic-only behavior (safe by
 * construction). Returns a `null` descriptor for non-human senders — the line is
 * then omitted (bots/services are reasoned via `sender_priors`, never the graph).
 *
 * Alongside the prose it now returns a TYPED `isColdContact` flag derived from
 * the same signals, so the rule-16b person-waiting todo gate can branch on it
 * deterministically instead of trusting the cheap model to self-apply the
 * `cold_sender:` rubric (which it doesn't — a cold cold-outreach mail minted a
 * rail todo the model itself tagged `cold_sender:`). The prose stays the model's
 * input; the flag is the floor's.
 */
import { bucketSignificance, type SignificanceBand } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { findPersonMetadataByAddress } from "../memory/significance";

/**
 * The buckets the cold-contact test reads: the significance band, or `unscored`
 * when there IS correspondence history but no significance pass has scored it
 * yet. `unscored` is deliberately NOT `weak` — `weak` is a real low score the
 * rubric reads as cold, `unscored` is the absence of a score.
 */
export type SenderSignificanceBucket = SignificanceBand | "unscored";

/**
 * Cold-contact test (rule 16b), PURE and directly testable — the producer of the
 * typed `isColdContact` signal the todo gate branches on. A HUMAN sender is cold
 * when the correspondence is NOT two-way AND is either one-way inbound (the user
 * never replied) OR scored `weak`:
 *   - two-way (inbound and outbound both > 0) → never cold, even `unscored`: the
 *     user sent at least one message back, so a real person is waiting;
 *   - one-way inbound (no outbound) → cold regardless of score;
 *   - one-way outbound ("you reached out") → cold only when scored `weak`;
 *   - `unscored` one-directional history → not cold unless one-way inbound.
 */
export function isColdContactFromSignals(args: {
  inbound: number;
  outbound: number;
  bucket: SenderSignificanceBucket;
}): boolean {
  const twoWay = args.inbound > 0 && args.outbound > 0;
  return !twoWay && (args.outbound === 0 || args.bucket === "weak");
}

function reciprocityPhrase(stats: { inbound: number; outbound: number }): string {
  if (stats.inbound > 0 && stats.outbound > 0) return "two-way thread";
  if (stats.outbound > 0) return "you reached out (no reply yet)";
  return "one-way inbound (you never replied)";
}

function factString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The user's own role for the `you: …` clause — `"Founder, Acme"` from the
 * `job_title` + `employer` facts. Job title leads; employer follows when present.
 * Returns `null` when neither fact is known (the clause is then dropped).
 */
async function loadUserRole(userId: string): Promise<string | null> {
  try {
    const rows = await db()
      .select({ key: userFacts.key, value: userFacts.value })
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          eq(userFacts.status, "confirmed"),
          inArray(userFacts.key, ["job_title", "employer", "company"]),
        ),
      );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const title = factString(byKey.get("job_title"));
    const company = factString(byKey.get("employer")) ?? factString(byKey.get("company"));
    if (title && company) return `${title}, ${company}`;
    return title ?? company ?? null;
  } catch {
    return null;
  }
}

/**
 * Structured result of the sender-relationship resolve. `descriptor` is the
 * prose line the cheap classifier reads (`renderObservations` owns the `Sender
 * relationship:` label); `null` for a non-human sender, whose line is omitted.
 */
export interface SenderRelationshipSignal {
  descriptor: string | null;
  /**
   * True when this HUMAN sender is a cold contact under rule 16b — `weak`
   * significance, one-way inbound (the user never replied), or no prior contact
   * on record. A two-way relationship (even `unscored`) is NOT cold. Always
   * `false` for a non-human sender: there is no "real person waiting" stake to
   * corroborate, and bots/services are reasoned via `sender_priors`.
   */
  isColdContact: boolean;
}

// A non-human sender: no relationship line, and no person-waiting stake to gate.
export const NON_HUMAN_RELATIONSHIP: SenderRelationshipSignal = {
  descriptor: null,
  isColdContact: false,
};
// A human sender whose graph read SUCCEEDED and found no row — genuinely no
// history. Cold by construction: the person-waiting stake is uncorroborated,
// exactly rule 16b's cold default.
const NO_PRIOR_CONTACT: SenderRelationshipSignal = {
  descriptor: "no prior contact on record",
  isColdContact: true,
};
// A human sender whose graph read FAILED — coldness is UNKNOWN, not confirmed
// absent, so this must NOT feed the deterministic gate as cold: a transient DB
// blip on a genuine two-way stakeholder would silently drop their real todo.
// Degrade to "keep the todo" (`isColdContact: false`), the same direction the
// caller's own outer catch takes ("err toward a real todo, not over-suppression")
// — the two "can't read the graph" events now fail the SAME way regardless of
// where the throw lands. Descriptor is null (no line) rather than a false "no
// prior contact on record": with the read failed we cannot honestly assert the
// history is empty. Distinct from NO_PRIOR_CONTACT (read succeeded → correctly
// cold) despite the identical shape to NON_HUMAN_RELATIONSHIP — the two carry
// different meaning (not-a-person vs could-not-read).
export const RELATIONSHIP_READ_FAILED: SenderRelationshipSignal = {
  descriptor: null,
  isColdContact: false,
};

/**
 * Resolve the `Sender relationship` signal for a human sender (prose + the typed
 * cold-contact flag), or the non-human default (`null` descriptor) otherwise.
 * Best-effort: never fails classify. A successful read with no history is the
 * cold `no prior contact` default; a READ FAILURE degrades to `unknown`
 * (`isColdContact: false`, keep the todo), NOT cold — the two must not be fused
 * because only the former is corroborated (#517 D2).
 */
export async function resolveSenderRelationship(args: {
  userId: string;
  senderAddress: string | null;
  /** Only `'person'` senders carry a relationship line. */
  isHumanSender: boolean;
}): Promise<SenderRelationshipSignal> {
  if (!args.isHumanSender || !args.senderAddress) return NON_HUMAN_RELATIONSHIP;

  // Shared alias→metadata lookup (one read path for both the resolver prose and
  // the ADR-0064 getSenderSignificance read). A null result (no row) is genuine
  // no-history (cold); a THROWN read failure degrades to unknown (not cold) —
  // distinct verdicts, neither fails classify.
  let meta: Awaited<ReturnType<typeof findPersonMetadataByAddress>>;
  try {
    meta = await findPersonMetadataByAddress(args.userId, args.senderAddress);
  } catch {
    // Read failed — coldness is UNKNOWN, so degrade to "keep the todo" rather
    // than the cold default that would over-suppress a real stakeholder on a blip.
    return RELATIONSHIP_READ_FAILED;
  }
  // A successful read that found no row is genuine no-history → correctly cold.
  if (!meta) return NO_PRIOR_CONTACT;

  const stats = meta.correspondence ?? { inbound: 0, outbound: 0, coRecipient: 0 };
  const significance = meta.significance;

  // A row with correspondence but no significance pass yet is `unscored`, NOT
  // `weak` — `weak` is a real low score the rubric reads as cold, and a
  // not-yet-scored two-way contact must not be mistaken for one. With no score,
  // reciprocity carries the relationship signal.
  const bucket: SenderSignificanceBucket = significance
    ? bucketSignificance(significance.score)
    : "unscored";

  // Cold (rule 16b): resolved by the pure {@link isColdContactFromSignals} test
  // so the derivation is directly unit-covered.
  const isColdContact = isColdContactFromSignals({
    inbound: stats.inbound,
    outbound: stats.outbound,
    bucket,
  });

  const parts: string[] = [bucket, reciprocityPhrase(stats)];
  // same-org is read straight from the stored significance components — no
  // separate domains query. Omit the clause when the row hasn't been scored yet.
  if (significance) {
    parts.push(significance.components.sameOrg >= 1 ? "same-org" : "not same-org");
  }

  const role = await loadUserRole(args.userId);
  if (role) parts.push(`you: "${role}"`);

  return { descriptor: parts.join(" · "), isColdContact };
}
