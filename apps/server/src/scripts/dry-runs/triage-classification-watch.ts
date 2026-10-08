/**
 * Read-only watch over `triage.classification` decision traces (#1099). Reports:
 *   1. how often the spam floor demotes a reply lane or holds a demand lane;
 *   2. how often an over-classification conflict on a non-person author gets a
 *      second pass, and how often that pass throws;
 *   3. which senders land in `awaiting_reply`.
 *
 * Why TypeScript, not SQL: `->>` on a missing JSON key returns NULL, so a renamed
 * key makes raw SQL report zero forever. Every key here goes through
 * {@link traceKey}, so a rename fails `check-types`.
 *
 * A renamed key is the only failure the compiler catches. A zero can also mean the
 * key is younger than the window or stopped being written, so each section prints
 * a key presence count beside it (#1187). Read a zero as "no answer", not "dead".
 *
 * Run (prod), from apps/server, with `railway connect --tunnel-only` open
 * (DATABASE_PUBLIC_URL is broken):
 *   pnpm exec tsx --env-file=.env src/scripts/dry-runs/triage-classification-watch.ts
 * Set `TRIAGE_WATCH_DAYS=30` to change the window (default 14).
 */
import { TRIAGE_WORKFLOW_SLUG } from "@alfred/assistant/triage";
import type {
  DecisionTraceFor,
  DecisionTraceKind,
} from "@alfred/assistant/execution/decision-traces";
import { toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { closeScriptResources } from "../script-runtime";

/** Trailing window in days. */
const WATCH_DAYS = Number(process.env.TRIAGE_WATCH_DAYS) || 14;

/** `satisfies` keeps the literal type, so {@link TraceRecord} reads the same registry entry. */
const TRACE_KIND = "triage.classification" satisfies DecisionTraceKind;

/**
 * The payload for {@link TRACE_KIND}, read from the registry, not imported by name.
 * Then the kind and the payload type cannot point at different entries.
 */
type TraceRecord = DecisionTraceFor<typeof TRACE_KIND>;

/** Type-check a trace key, so a rename breaks the build. Never put a bare string after `->>`. */
const traceKey = (key: keyof TraceRecord & string): string => key;

/** `trace ->> '<key>'`. The `::text` cast is optional; it names `jsonb ->> text`, not `->> int`. */
const traceText = (key: keyof TraceRecord & string): SQL =>
  sql`(t.trace ->> ${traceKey(key)}::text)`;

/** Exhaustive over `spamFloorOutcome`, so a new member is a compile error, not a missing bucket. */
const SPAM_FLOOR_OUTCOMES = {
  demoted_reply_lane: "the floor pulled a reply lane down to fyi",
  held_demand_lane: "the floor let a demand lane stand (the softened path)",
} satisfies Record<NonNullable<TraceRecord["spamFloorOutcome"]>, string>;

/**
 * Spam rows with no `spamFloorOutcome`. Three causes: an inert floor, a row older
 * than the key, or a classify that threw (the trace still has `gmailSpam: true`).
 */
const SPAM_FLOOR_INERT = "(null)";

// Annotated, so a renamed member is a compile error.
const OVER_CLASSIFICATION: NonNullable<TraceRecord["conflict"]> = "over_classification";

const PERSON_AUTHOR: TraceRecord["effectiveAuthor"] = "person";

const AWAITING_REPLY: TraceRecord["finalCategory"] = "awaiting_reply";

/**
 * CTE of the latest attempt per run in the window. Filter on `decided_at`, which
 * `agent_decision_traces_workflow_kind_idx` covers; `created_at` has no index.
 */
function withLatest(body: SQL): SQL {
  return sql`
    WITH t AS (
      SELECT DISTINCT ON (run_id) run_id, trace
      FROM agent_decision_traces
      WHERE workflow_slug = ${TRIAGE_WORKFLOW_SLUG}
        AND kind = ${TRACE_KIND}
        AND decided_at >= now() - ${`${WATCH_DAYS} days`}::interval
      ORDER BY run_id, attempt DESC
    )
    ${body}
  `;
}

/** Parse driver rows. Counts are cast to `int` in SQL, because a bigint arrives as a string. */
async function query<T extends z.ZodType>(statement: SQL, rowSchema: T): Promise<z.infer<T>[]> {
  const result: unknown = await db().execute(statement);
  const rows = z.object({ rows: z.array(z.unknown()) }).safeParse(result);

  return z.array(rowSchema).parse(rows.success ? rows.data.rows : result);
}

const countRow = z.object({ n: z.number() });

/** `x/y (z%)`, or `n/a` for a zero denominator. */
function share(numerator: number, denominator: number): string {
  const pct = denominator === 0 ? "n/a" : `${((numerator / denominator) * 100).toFixed(1)}%`;

  return `${numerator}/${denominator} (${pct})`;
}

async function totalClassifications(): Promise<number> {
  const [row] = await query(withLatest(sql`SELECT count(*)::int AS n FROM t`), countRow);

  return row?.n ?? 0;
}

/** Watch 1: spam floor outcomes. The denominator is Gmail-filed spam, the only mail the floor sees. */
async function watchSpamFloor(total: number): Promise<void> {
  console.log(`\n## 1. Spam floor — outcomes over Gmail-filed spam`);

  // GROUP BY, so a value outside SPAM_FLOOR_OUTCOMES prints as UNKNOWN instead of vanishing.
  const rows = await query(
    withLatest(sql`
      SELECT
        coalesce(${traceText("spamFloorOutcome")}, ${SPAM_FLOOR_INERT}) AS outcome,
        count(*)::int AS n,
        count(*) FILTER (WHERE t.trace ? ${traceKey("spamFloorOutcome")})::int AS outcome_present
      FROM t
      WHERE ${traceText("gmailSpam")} = 'true'
      GROUP BY 1
    `),
    z.object({ outcome: z.string(), n: z.number(), outcome_present: z.number() }),
  );

  const counts = new Map(rows.map((row) => [row.outcome, row.n]));
  const spamTotal = rows.reduce((sum, row) => sum + row.n, 0);
  const outcomePresent = rows.reduce((sum, row) => sum + row.outcome_present, 0);

  // If the window predates the key, both this and `spamTotal` are 0.
  const [spamKey] = await query(
    withLatest(
      sql`SELECT count(*) FILTER (WHERE t.trace ? ${traceKey("gmailSpam")})::int AS n FROM t`,
    ),
    countRow,
  );

  console.log(`   spam-filed mail in window: ${share(spamTotal, total)} of all classifications`);
  console.log(`   …gmailSpam key present (window): ${share(spamKey?.n ?? 0, total)}`);
  console.log(`   …spamFloorOutcome key present: ${share(outcomePresent, spamTotal)}`);

  for (const [outcome, label] of Object.entries(SPAM_FLOOR_OUTCOMES)) {
    console.log(`   ${outcome} — ${label}: ${share(counts.get(outcome) ?? 0, spamTotal)}`);
  }

  console.log(
    `   ${SPAM_FLOOR_INERT} — floor inert, or the key predates the row, or classify threw: ` +
      `${share(counts.get(SPAM_FLOOR_INERT) ?? 0, spamTotal)}`,
  );

  for (const row of rows) {
    if (row.outcome === SPAM_FLOOR_INERT || row.outcome in SPAM_FLOOR_OUTCOMES) continue;

    console.log(
      `   ! UNKNOWN spamFloorOutcome '${row.outcome}': ${share(row.n, spamTotal)} — the floor ` +
        `writes a member SPAM_FLOOR_OUTCOMES does not list; add it there.`,
    );
  }
}

/**
 * Watch 2: over-classification second passes where `effectiveAuthor <> 'person'`
 * (bot, service, and unknown). Reads `conflict`, not the model tag: `LIKE '%+2pass%'`
 * also matches `+2pass_failed`. `secondPassFailure` is set on any second-pass throw,
 * so count it only under the conflict filter.
 */
async function watchOverClassification(total: number): Promise<void> {
  console.log(`\n## 2. Over-classification second passes on non-person authors`);

  const rows = await query(
    withLatest(sql`
      SELECT
        count(*) FILTER (WHERE ${traceText("conflict")} IS NOT NULL)::int AS any_conflict,
        count(*) FILTER (
          WHERE ${traceText("conflict")} = ${OVER_CLASSIFICATION}
        )::int AS over_classification,
        count(*) FILTER (
          WHERE ${traceText("conflict")} = ${OVER_CLASSIFICATION}
            AND ${traceText("effectiveAuthor")} <> ${PERSON_AUTHOR}
        )::int AS non_person_authors,
        count(*) FILTER (
          WHERE ${traceText("conflict")} = ${OVER_CLASSIFICATION}
            AND ${traceText("effectiveAuthor")} <> ${PERSON_AUTHOR}
            AND ${traceText("secondPassFailure")} IS NOT NULL
        )::int AS non_person_author_failures,
        count(*) FILTER (WHERE t.trace ? ${traceKey("conflict")})::int AS conflict_present,
        count(*) FILTER (WHERE t.trace ? ${traceKey("effectiveAuthor")})::int AS effective_author_present,
        count(*) FILTER (WHERE t.trace ? ${traceKey("secondPassFailure")})::int AS second_pass_failure_present
      FROM t
    `),
    z.object({
      any_conflict: z.number(),
      over_classification: z.number(),
      non_person_authors: z.number(),
      non_person_author_failures: z.number(),
      conflict_present: z.number(),
      effective_author_present: z.number(),
      second_pass_failure_present: z.number(),
    }),
  );

  const row = rows[0] ?? {
    any_conflict: 0,
    over_classification: 0,
    non_person_authors: 0,
    non_person_author_failures: 0,
    conflict_present: 0,
    effective_author_present: 0,
    second_pass_failure_present: 0,
  };

  console.log(`   second pass attempted (any conflict): ${share(row.any_conflict, total)}`);
  console.log(`   ${OVER_CLASSIFICATION}: ${share(row.over_classification, total)}`);
  console.log(
    `   …of which the author is not '${PERSON_AUTHOR}' (bot/service/unknown): ${share(row.non_person_authors, row.over_classification)}`,
  );
  console.log(
    `   …and the second pass threw: ${share(row.non_person_author_failures, row.non_person_authors)}`,
  );
  console.log(`   …conflict key present (window): ${share(row.conflict_present, total)}`);
  console.log(
    `   …effectiveAuthor key present (window): ${share(row.effective_author_present, total)}`,
  );
  console.log(
    `   …secondPassFailure key present (window): ${share(row.second_pass_failure_present, total)}`,
  );
}

/** Watch 3: senders in `awaiting_reply`. A relay or service sender there is a miss. */
async function watchAwaitingReplySenders(total: number): Promise<void> {
  console.log(`\n## 3. Fresh '${AWAITING_REPLY}' rows, by sender`);

  const rows = await query(
    withLatest(sql`
      SELECT
        coalesce(${traceText("senderAddress")}, '(none)') AS sender_address,
        coalesce(${traceText("senderDomain")}, '(none)') AS sender_domain,
        coalesce(${traceText("effectiveAuthor")}, '(none)') AS effective_author,
        coalesce(${traceText("fromKind")}, '(none)') AS from_kind,
        coalesce(${traceText("senderKind")}, '-') AS sender_kind,
        count(*)::int AS n,
        count(*) FILTER (WHERE t.trace ? ${traceKey("effectiveAuthor")})::int AS effective_author_present,
        count(*) FILTER (WHERE t.trace ? ${traceKey("fromKind")})::int AS from_kind_present,
        count(*) FILTER (WHERE t.trace ? ${traceKey("senderKind")})::int AS sender_kind_present
      FROM t
      WHERE ${traceText("finalCategory")} = ${AWAITING_REPLY}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 6 DESC, 1 ASC
    `),
    z.object({
      sender_address: z.string(),
      sender_domain: z.string(),
      effective_author: z.string(),
      from_kind: z.string(),
      sender_kind: z.string(),
      n: z.number(),
      effective_author_present: z.number(),
      from_kind_present: z.number(),
      sender_kind_present: z.number(),
    }),
  );

  const inLane = rows.reduce((sum, row) => sum + row.n, 0);

  const nonPerson = rows
    .filter((row) => row.effective_author !== PERSON_AUTHOR)
    .reduce((sum, row) => sum + row.n, 0);

  // A '-' senderKind is an absent key, not a quiet parser.
  const keyPresent = rows.reduce((sum, row) => sum + row.sender_kind_present, 0);
  const authorPresent = rows.reduce((sum, row) => sum + row.effective_author_present, 0);
  const fromKindPresent = rows.reduce((sum, row) => sum + row.from_kind_present, 0);

  // Every lane row has `finalCategory`, so count its presence over the whole window.
  const [laneKey] = await query(
    withLatest(
      sql`SELECT count(*) FILTER (WHERE t.trace ? ${traceKey("finalCategory")})::int AS n FROM t`,
    ),
    countRow,
  );

  console.log(`   rows in lane: ${share(inLane, total)}`);
  console.log(
    `   …authored by something other than '${PERSON_AUTHOR}': ${share(nonPerson, inLane)}`,
  );
  console.log(`   …finalCategory key present (window): ${share(laneKey?.n ?? 0, total)}`);
  console.log(`   …effectiveAuthor key present: ${share(authorPresent, inLane)}`);
  console.log(`   …fromKind key present: ${share(fromKindPresent, inLane)}`);
  console.log(`   …senderKind key present: ${share(keyPresent, inLane)}`);

  if (rows.length === 0) return;

  console.log(`   n  author/fromKind/senderKind          sender`);
  console.log(
    `   ('-'/'(none)' = coalesced null; trailing [key absent] marks a group carrying no key)`,
  );

  for (const row of rows) {
    const mark = row.effective_author === PERSON_AUTHOR ? "   " : " * ";
    const senderIdentity = `${row.effective_author}/${row.from_kind}/${row.sender_kind}`;

    const absent = [
      row.effective_author_present === 0 ? "effectiveAuthor" : null,
      row.from_kind_present === 0 ? "fromKind" : null,
      row.sender_kind_present === 0 ? "senderKind" : null,
    ].filter((key) => key !== null);

    const presence = absent.length > 0 ? ` [key absent: ${absent.join(", ")}]` : "";

    console.log(
      `  ${mark}${String(row.n).padStart(3)}  ${senderIdentity.padEnd(34)} ${row.sender_address} (${row.sender_domain})${presence}`,
    );
  }

  console.log(`   ( * = not a person — inspect these; a reply lane owes its sender an answer)`);
}

async function main() {
  await warmPool();
  console.log(
    `# triage.classification watch — READ-ONLY | kind=${TRACE_KIND} | ` +
      `workflow=${TRIAGE_WORKFLOW_SLUG} | window=${WATCH_DAYS}d | latest attempt per run`,
  );

  const total = await totalClassifications();

  console.log(`\n# window denominator: ${total} classification(s)`);

  if (total === 0) {
    console.log(
      "! the window is EMPTY — every rate below would read 0/0. Widen TRIAGE_WATCH_DAYS or " +
        "check that you are pointed at the prod database.",
    );
  }

  await watchSpamFloor(total);
  await watchOverClassification(total);
  await watchAwaitingReplySenders(total);

  console.log("\n# done (nothing written)");
}

main()
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
