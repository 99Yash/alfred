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
 *   - the user's own role from `user_facts` (`job_title`/`company`).
 *
 * A human sender with no graph row renders `no prior contact on record`, so the
 * rubric degrades to exactly today's intrinsic-only behavior (safe by
 * construction). Returns `null` for non-human senders — the line is then
 * omitted (bots/services are reasoned via `sender_priors`, never the graph).
 */
import { db } from "@alfred/db";
import { entities, userFacts } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parsePersonEntityMetadata } from "../memory/entity-metadata";

/** Significance scalar → word. The two cutoffs are the only numeric knobs (ADR-0059 amendment, tunable from data). */
const STRONG_AT = 0.66;
const MODERATE_AT = 0.33;

function bucketSignificance(score: number): "strong" | "moderate" | "weak" {
  if (score >= STRONG_AT) return "strong";
  if (score >= MODERATE_AT) return "moderate";
  return "weak";
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
 * `job_title` + `company` facts. Job title leads; company follows when present.
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
          inArray(userFacts.key, ["job_title", "company"]),
        ),
      );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const title = factString(byKey.get("job_title"));
    const company = factString(byKey.get("company"));
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
  const target = args.senderAddress.trim().toLowerCase();
  if (!target) return null;

  let metadataRaw: unknown;
  try {
    const rows = await db()
      .select({ metadata: entities.metadata })
      .from(entities)
      .where(
        and(
          eq(entities.userId, args.userId),
          eq(entities.kind, "person"),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE lower(alias) = ${target}
          )`,
        ),
      )
      .limit(1);
    if (rows.length === 0) return "no prior contact on record";
    metadataRaw = rows[0]?.metadata;
  } catch {
    return "no prior contact on record";
  }

  const meta = parsePersonEntityMetadata(metadataRaw);
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
