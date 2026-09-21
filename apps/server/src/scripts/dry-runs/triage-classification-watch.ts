/**
 * Standing watch over `triage.classification` decision traces (#1099) —
 * READ-ONLY, `tsx`-only.
 *
 * Answers three questions the sender-not-phrases work (#1097/#1098) left open,
 * from data rather than from inbox annoyance:
 *
 *   1. How often does the spam floor demote a reply lane, and how often does it
 *      hold a demand lane? (`spamFloorOutcome` over Gmail-filed spam.)
 *   2. How often does an over-classification conflict send a NON-PERSON
 *      envelope to a second pass, and how often does that second pass throw?
 *   3. Which senders are landing in `awaiting_reply`? A relay or service
 *      envelope in a reply lane is the exact shape of the miss #1097 fixed.
 *
 * WHY THIS IS TYPESCRIPT AND NOT SQL IN A DOC. A Postgres `->>` against a JSON
 * key that does not exist reads as SQL NULL — it does not fail. So a hand-written
 * query is a SILENT duplicate of {@link TraceRecord}: when a key is
 * renamed, the query keeps running and reports zero forever. That is not
 * hypothetical. While #1098 was in review the spam audit key moved from
 * `spamDemotionReason` to `spamFloorOutcome`, and the conventional
 * `<floor>DemotionReason IS NOT NULL` query would have reported no spam-floor
 * activity at all, with nothing failing. Every JSON key below therefore goes
 * through {@link traceKey}, and every member string is annotated with the type
 * that owns it, so a rename breaks `pnpm check-types` instead of the watch.
 *
 * WHAT THE COMPILER DOES NOT CATCH, AND THIS FILE DOES NOT EITHER. The tier-1
 * claim above covers exactly one failure mode: a RENAMED key. It does not cover
 * a key that still exists but carries no value in the window. Every section
 * therefore prints its numerator against the window's total distinct-run
 * `triage.classification` count, which separates an empty window (0/0) from a
 * populated one — but a populated window still prints the SAME zero for three
 * different situations: a key younger than the window, a key that stopped being
 * written, and a mechanism that simply stayed quiet. Measured, not argued: a
 * local run printed `spam-filed mail in window: 0/160`, and the cause was that
 * `gmailSpam` was one day old, not that Gmail filed no spam. So read a zero here
 * as "no answer", never as "dead". Telling those apart needs a presence count
 * (`t.trace ? '<key>'`, i.e. how many rows carry the key at all) beside each
 * numerator; this file does not have one yet.
 *
 * NOT bundled by tsdown: it makes no model call — it reads
 * `agent_decision_traces` — so a local `tsx` over the documented prod tunnel
 * reaches it. Do not read that as "a script that classifies must be bundled":
 * three siblings in this directory (`dry-run-triage-backfill.ts`,
 * `triage-prompt-replay.ts`, `dry-run-attribution-fixtures.ts`) call
 * `classifyEmail` and are unbundled too. A bundle entry buys a prod `node`
 * command, nothing else:
 *
 *   # prod, in one terminal:
 *   railway connect --tunnel-only            # DATABASE_PUBLIC_URL is broken; use the tunnel
 *   # then, from apps/server:
 *   pnpm exec tsx --env-file=.env src/scripts/dry-runs/triage-classification-watch.ts
 *
 *   # widen or narrow the window (days, default 14):
 *   TRIAGE_WATCH_DAYS=30 pnpm exec tsx --env-file=.env src/scripts/dry-runs/triage-classification-watch.ts
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

/**
 * The trace kind this watch reads. `satisfies` (not an annotation) keeps the
 * literal type, so {@link TraceRecord} can read the payload back out of the
 * SAME registry entry. Renaming the kind triage declares
 * (`sender-extraction-event.ts`) fails here.
 */
const TRACE_KIND = "triage.classification" satisfies DecisionTraceKind;

/**
 * The payload {@link TRACE_KIND} carries, resolved through execution's open
 * registry rather than imported by name.
 *
 * This correlation is the point. `DecisionTraceKind` is a UNION — today
 * `triage.classification` plus `reply_drafting.decision` — so a hand-typed kind
 * beside a hand-imported payload type lets a person repoint one and leave the
 * other. Every key below then still compiles, every query still runs,
 * and every section reports zero. Reading both out of one registry entry makes
 * the repoint a compile error instead. Today this resolves to triage's
 * `SenderExtractionEvent`.
 */
type TraceRecord = DecisionTraceFor<typeof TRACE_KIND>;

/**
 * Name a `triage.classification` trace key so a rename breaks the build, not the
 * query. This is the whole tier-1 claim of this file: a bare string literal in a
 * `->>` position is the one thing a reviewer must reject here.
 */
const traceKey = (key: keyof TraceRecord & string): string => key;

/**
 * `trace ->> '<key>'` as text, with the key routed through {@link traceKey}. The
 * explicit `::text` cast is deliberate but NOT required. Postgres resolves an
 * unknown parameter to `text` by itself, so the uncast form runs: probed with
 * `PREPARE p1 AS SELECT '{"a":"x"}'::jsonb ->> $1`, which prepares and returns
 * `x`. The cast is kept because it names the operator this report means —
 * `jsonb ->> text`, never `jsonb ->> int` — at the call site.
 */
const traceText = (key: keyof TraceRecord & string): SQL =>
  sql`(t.trace ->> ${traceKey(key)}::text)`;

/**
 * Every `spamFloorOutcome` member, with the line this report prints for it.
 *
 * The `satisfies Record<…>` is the point; the labels are incidental. Each member
 * SPELLING was already tier 1 as a lone annotated const, but the member SET was
 * tier 4: a third member would fall into no bucket, the printed shares would
 * stop summing to the spam total, and nothing would fail. That add case is live
 * — #1098 introduced the second member. With the table exhaustive, a new member
 * is a compile error here, and {@link watchSpamFloor} derives its buckets from
 * these keys, so the report grows with the union instead of drifting from it.
 */
const SPAM_FLOOR_OUTCOMES = {
  demoted_reply_lane: "the floor pulled a reply lane down to fyi",
  held_demand_lane: "the floor let a demand lane stand (the softened path)",
} satisfies Record<NonNullable<TraceRecord["spamFloorOutcome"]>, string>;

/**
 * Bucket for a spam row whose `spamFloorOutcome` reads as SQL NULL. THREE causes
 * land here, not two: a real inert floor (the mail was not in a lane the floor
 * governs), a row written before the key existed, and a classify that THREW.
 * On the throw path `workflow-operations.ts` keeps `observations` and leaves
 * `audit` null, so the trace is still written with `gmailSpam: true` and no
 * outcome — a FAILED classify prints here as "floor inert", which is this
 * report's worst reading. `->>` cannot tell an absent key from a JSON null,
 * which is the same limit the header states. Item 37 owns the discriminator.
 */
const SPAM_FLOOR_INERT = "(null)";

// Member strings, each annotated with the type that owns it. A renamed MEMBER
// (not just a renamed key) is a compile error at these lines.
const OVER_CLASSIFICATION: NonNullable<TraceRecord["conflict"]> = "over_classification";

const PERSON_AUTHOR: TraceRecord["effectiveAuthor"] = "person";

const AWAITING_REPLY: TraceRecord["finalCategory"] = "awaiting_reply";

/**
 * Latest attempt per run inside the window, as a CTE every section selects from.
 *
 * `workflow_slug` + `kind` + `decided_at` is exactly
 * `agent_decision_traces_workflow_kind_idx`; `created_at` has NO index, so the
 * window must be on `decided_at`. A retried attempt writes a DISTINCT row
 * (`attempt` is in the unique key), so `DISTINCT ON (run_id) … ORDER BY run_id,
 * attempt DESC` keeps one row per classification and not one per try.
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

/**
 * Rows come back from the driver untyped, so each query states its own shape and
 * parses it here rather than asserting it. `count(*)` arrives as a string from
 * `node-postgres` on bigint columns; every count below is cast to `int` in SQL,
 * which the driver returns as a number.
 */
async function query<T extends z.ZodType>(statement: SQL, rowSchema: T): Promise<z.infer<T>[]> {
  const result: unknown = await db().execute(statement);
  const rows = z.object({ rows: z.array(z.unknown()) }).safeParse(result);

  return z.array(rowSchema).parse(rows.success ? rows.data.rows : result);
}

const countRow = z.object({ n: z.number() });

/** `x/y (z%)`, with an honest `n/a` when the denominator is zero. */
function share(numerator: number, denominator: number): string {
  const pct = denominator === 0 ? "n/a" : `${((numerator / denominator) * 100).toFixed(1)}%`;

  return `${numerator}/${denominator} (${pct})`;
}

async function totalClassifications(): Promise<number> {
  const [row] = await query(withLatest(sql`SELECT count(*)::int AS n FROM t`), countRow);

  return row?.n ?? 0;
}

/**
 * Watch 1 — the spam floor. The denominator is Gmail-filed spam, not the whole
 * window: the floor cannot fire on anything else. `null` means the floor was
 * inert (the mail was not in a lane the floor governs), which is a legitimate
 * third outcome and is printed as such.
 */
async function watchSpamFloor(total: number): Promise<void> {
  console.log(`\n## 1. Spam floor — outcomes over Gmail-filed spam`);

  // GROUP BY, not one FILTER per member: the group keys come back from the data,
  // so every spam row lands in exactly one printed bucket and the shares sum to
  // the spam total. A value outside SPAM_FLOOR_OUTCOMES then has nowhere to hide
  // — it prints as UNKNOWN below instead of vanishing from the report.
  const rows = await query(
    withLatest(sql`
      SELECT
        coalesce(${traceText("spamFloorOutcome")}, ${SPAM_FLOOR_INERT}) AS outcome,
        count(*)::int AS n
      FROM t
      WHERE ${traceText("gmailSpam")} = 'true'
      GROUP BY 1
    `),
    z.object({ outcome: z.string(), n: z.number() }),
  );

  const counts = new Map(rows.map((row) => [row.outcome, row.n]));
  const spamTotal = rows.reduce((sum, row) => sum + row.n, 0);

  console.log(`   spam-filed mail in window: ${share(spamTotal, total)} of all classifications`);

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
 * Watch 2 — over-classification second passes on non-person authors.
 *
 * "Non-person", not "service": the filter is `effectiveAuthor <> 'person'`, and
 * `effectiveAuthor` is `bot | person | service | unknown`, so this counts `bot`
 * and `unknown` beside `service`. Widening it that way is deliberate — an
 * envelope the extractor could not attribute is exactly as suspicious in a
 * demand lane as one it named a service — but the name must not read as
 * `= 'service'`.
 *
 * Reads the trace's own `conflict` key, NOT the `email_triage.model` tag. Two
 * reasons: the tag is not in the trace at all, and matching it by substring is a
 * trap — `'+2pass_failed'` contains `'+2pass'`, so `LIKE '%+2pass%'` counts a
 * FAILED second pass as a successful one. `conflict` answers the same question
 * with neither problem.
 *
 * The `secondPassFailure IS NOT NULL` count is NESTED under the
 * over-classification non-person count — a third conjunct in the SQL, and a
 * `d/c` share printed under `c/b`. That nesting is what makes it readable: the
 * column itself is set on ANY second-pass throw, before the conflict kind is
 * consulted, so on its own it names a failed re-check and nothing more. Read
 * under the conflict filter it names a failed re-check of THIS class.
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
        )::int AS non_person_author_failures
      FROM t
    `),
    z.object({
      any_conflict: z.number(),
      over_classification: z.number(),
      non_person_authors: z.number(),
      non_person_author_failures: z.number(),
    }),
  );

  const row = rows[0] ?? {
    any_conflict: 0,
    over_classification: 0,
    non_person_authors: 0,
    non_person_author_failures: 0,
  };

  console.log(`   second pass attempted (any conflict): ${share(row.any_conflict, total)}`);
  console.log(`   ${OVER_CLASSIFICATION}: ${share(row.over_classification, total)}`);
  console.log(
    `   …of which the author is not '${PERSON_AUTHOR}' (bot/service/unknown): ${share(row.non_person_authors, row.over_classification)}`,
  );
  console.log(
    `   …and the second pass threw: ${share(row.non_person_author_failures, row.non_person_authors)}`,
  );
}

/**
 * Watch 3 — who is landing in `awaiting_reply`.
 *
 * A reply lane asserts the SENDER is owed an answer. A relay, a no-reply
 * envelope or a known service domain in that lane is the miss #1097 started
 * from, so this prints the sender identity beside the count instead of a bare
 * rate. `senderAddress`/`senderDomain` are on the trace itself, so this needs no
 * join — the trace names no document, thread or message.
 */
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
        count(*)::int AS n
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
    }),
  );

  const inLane = rows.reduce((sum, row) => sum + row.n, 0);

  const nonPerson = rows
    .filter((row) => row.effective_author !== PERSON_AUTHOR)
    .reduce((sum, row) => sum + row.n, 0);

  console.log(`   rows in lane: ${share(inLane, total)}`);
  console.log(
    `   …authored by something other than '${PERSON_AUTHOR}': ${share(nonPerson, inLane)}`,
  );

  if (rows.length === 0) return;

  console.log(`   n  author/fromKind/senderKind          sender`);

  for (const row of rows) {
    const mark = row.effective_author === PERSON_AUTHOR ? "   " : " * ";
    const senderIdentity = `${row.effective_author}/${row.from_kind}/${row.sender_kind}`;

    console.log(
      `  ${mark}${String(row.n).padStart(3)}  ${senderIdentity.padEnd(34)} ${row.sender_address} (${row.sender_domain})`,
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
