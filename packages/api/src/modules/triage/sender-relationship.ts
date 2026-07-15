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
import { bucketSignificance } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { findPersonMetadataByAddress } from "../memory/significance";

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
const NON_HUMAN_RELATIONSHIP: SenderRelationshipSignal = { descriptor: null, isColdContact: false };
// A human sender with no graph row (or a DB blip). Cold by construction: the
// person-waiting stake is uncorroborated, exactly rule 16b's cold default.
const NO_PRIOR_CONTACT: SenderRelationshipSignal = {
  descriptor: "no prior contact on record",
  isColdContact: true,
};

/**
 * Resolve the `Sender relationship` signal for a human sender (prose + the typed
 * cold-contact flag), or the non-human default (`null` descriptor) otherwise.
 * Best-effort: any DB blip degrades to the safe cold "no prior contact" default
 * rather than failing classify.
 */
export async function resolveSenderRelationship(args: {
  userId: string;
  senderAddress: string | null;
  /** Only `'person'` senders carry a relationship line. */
  isHumanSender: boolean;
}): Promise<SenderRelationshipSignal> {
  if (!args.isHumanSender || !args.senderAddress) return NON_HUMAN_RELATIONSHIP;

  // Shared alias→metadata lookup (one read path for both the resolver prose and
  // the ADR-0064 getSenderSignificance read). Null (no row) or any DB blip
  // degrades to the safe "no prior contact" default rather than failing classify.
  let meta: Awaited<ReturnType<typeof findPersonMetadataByAddress>>;
  try {
    meta = await findPersonMetadataByAddress(args.userId, args.senderAddress);
  } catch {
    return NO_PRIOR_CONTACT;
  }
  if (!meta) return NO_PRIOR_CONTACT;

  const stats = meta.correspondence ?? { inbound: 0, outbound: 0, coRecipient: 0 };
  const significance = meta.significance;

  // A row with correspondence but no significance pass yet is `unscored`, NOT
  // `weak` — `weak` is a real low score the rubric reads as cold, and a
  // not-yet-scored two-way contact must not be mistaken for one. With no score,
  // reciprocity carries the relationship signal.
  const bucket = significance ? bucketSignificance(significance.score) : "unscored";

  // Cold (rule 16b) = NOT a two-way thread AND (one-way inbound OR `weak`). A
  // two-way thread — the user sent at least one message back — is a real person
  // waiting even when `unscored`, so it is never cold. Absent any outbound the
  // thread is one-way inbound → cold regardless of score. `weak` demotes a
  // scored-but-low one-directional contact.
  const twoWay = stats.inbound > 0 && stats.outbound > 0;
  const isColdContact = !twoWay && (stats.outbound === 0 || bucket === "weak");

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
