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
 * construction). Returns `null` for non-human senders — the line is then
 * omitted (bots/services are reasoned via `sender_priors`, never the graph).
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
 * Resolve the rendered `Sender relationship` descriptor for a human sender, or
 * `null` for a non-human sender (caller omits the line). Best-effort: any DB
 * blip yields `no prior contact on record` rather than failing classify.
 *
 * Returns only the value part — `renderObservations` owns the `Sender
 * relationship:` label, mirroring how it owns `Known contact:`.
 */
export async function resolveSenderRelationship(args: {
  userId: string;
  senderAddress: string | null;
  /** Only `'person'` senders carry a relationship line. */
  isHumanSender: boolean;
}): Promise<string | null> {
  if (!args.isHumanSender || !args.senderAddress) return null;

  // Shared alias→metadata lookup (one read path for both the resolver prose and
  // the ADR-0064 getSenderSignificance read). Null (no row) or any DB blip
  // degrades to the safe "no prior contact" default rather than failing classify.
  let meta: Awaited<ReturnType<typeof findPersonMetadataByAddress>>;
  try {
    meta = await findPersonMetadataByAddress(args.userId, args.senderAddress);
  } catch {
    return "no prior contact on record";
  }
  if (!meta) return "no prior contact on record";

  const stats = meta.correspondence ?? { inbound: 0, outbound: 0, coRecipient: 0 };
  const significance = meta.significance;

  // A row with correspondence but no significance pass yet is `unscored`, NOT
  // `weak` — `weak` is a real low score the rubric reads as cold, and a
  // not-yet-scored two-way contact must not be mistaken for one. With no score,
  // reciprocity (below) carries the relationship signal.
  const parts: string[] = [
    significance ? bucketSignificance(significance.score) : "unscored",
    reciprocityPhrase(stats),
  ];
  // same-org is read straight from the stored significance components — no
  // separate domains query. Omit the clause when the row hasn't been scored yet.
  if (significance) {
    parts.push(significance.components.sameOrg >= 1 ? "same-org" : "not same-org");
  }

  const role = await loadUserRole(args.userId);
  if (role) parts.push(`you: "${role}"`);

  return parts.join(" · ");
}
