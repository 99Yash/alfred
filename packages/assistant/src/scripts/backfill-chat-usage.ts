/**
 * One-off backfill for the dev usage readout (models + tokens + cost) on chat
 * turns that finished BEFORE the `chat_messages.usage` column existed
 * (introduced today in e239c705 / migration 0084).
 *
 * The live path (`aggregateRunUsage` in src/execution/usage-fold.ts) rolls the
 * numbers up from the turn's `api_call_log` rows at finalize, keyed on the boss
 * `runId`. Those metering rows are the ADR-0015 source of truth and are NOT
 * pruned, so every older assistant message is still backfillable from our own
 * DB — no Langfuse round-trip needed (Langfuse only mirrors `api_call_log.model`
 * and has retention limits the DB doesn't). This script reruns that exact
 * aggregation for messages whose `usage` is still null.
 *
 * Dry-run by default (reports what it WOULD write); pass --commit to persist.
 *
 *   $ pnpm --filter @alfred/assistant exec tsx src/scripts/backfill-chat-usage.ts
 *   $ pnpm --filter @alfred/assistant exec tsx src/scripts/backfill-chat-usage.ts --commit
 *
 * Scope (identical to the live feature):
 *   - role='assistant' rows with a non-null run_id whose usage rollup is
 *     incomplete: usage is null (finalized before the column existed), OR usage
 *     was written by an early build that omitted the `models` array (the model
 *     chips render off `usage.models`, so those turns show the token/cost line
 *     but no model — the whole point of the readout), OR usage predates the
 *     per-agent split and therefore still holds a boss-only total, OR usage
 *     predates `modelLatencyMs` and therefore cannot show output throughput;
 *   - sub-agent child runs are folded into the turn that spawned them, and
 *     labeled by their `subId` in the split, because a delegating turn spends
 *     most of its money in its children;
 *   - a turn whose api_call_log rows are gone (INNER JOIN misses) stays as-is —
 *     the UI already renders a missing/empty rollup gracefully.
 */

import { db, closeConnections } from "@alfred/db";
import { agentRuns, apiCallLog, chatMessages } from "@alfred/db/schemas";
import { chatMessageUsageSchema, type ChatMessageUsage } from "@alfred/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { foldModelUsage } from "@alfred/assistant/execution/usage-fold";

const COMMIT = process.argv.includes("--commit");

/**
 * The turn a metering row belongs to: the run that made the call, or — when
 * that run is a sub-agent — the boss run that spawned it. Sub-agents cannot
 * spawn sub-agents, so one hop reaches the boss from any run.
 */
const OWNER_RUN_ID = sql`coalesce(${agentRuns.metadata}->'subAgent'->>'parentRunId', ${apiCallLog.runId})`;

/** Which agent made the call: null for the boss's own run, else the child's `subId`. */
const SUB_ID = sql<
  string | null
>`case when ${apiCallLog.runId} = ${chatMessages.runId} then null else coalesce(${agentRuns.metadata}->'subAgent'->>'subId', 'sub-agent') end`;

const MODEL = sql<string>`coalesce(${apiCallLog.model}, 'unknown')`;
const CALL_ROLE = sql<string | null>`${apiCallLog.requestMeta}->>'role'`;

/**
 * One `api_call_log` group per (message, agent, model), summed across every run
 * that billed into the message's turn — the same GROUP BY `aggregateRunUsage`
 * runs, widened to carry the owning message id so we can fold every candidate in
 * a single scan (no N+1).
 *
 * Driven from `api_call_log` and mapped up to its owning turn (rather than
 * joining down from each message) so the whole backfill is one pass with plain
 * equi-joins, instead of a correlated child lookup per message. The `agent_runs`
 * join is LEFT so a metering row whose run row is gone still counts, as the boss
 * run's own spend.
 */
async function loadGroups(): Promise<
  Array<{
    messageId: string;
    kind: string;
    role: string | null;
    subId: string | null;
    model: string;
    inputTokens: string;
    outputTokens: string;
    cachedInputTokens: string;
    modelLatencyMs: string;
    costUsd: string;
    calls: string;
  }>
> {
  return db()
    .select({
      messageId: chatMessages.id,
      kind: apiCallLog.kind,
      role: CALL_ROLE,
      subId: SUB_ID,
      model: MODEL,
      inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      modelLatencyMs: sql<string>`coalesce(sum(case
        when ${apiCallLog.kind} = 'llm'
          and ${apiCallLog.error} is null
          and ${apiCallLog.outputTokens} is not null
        then ${apiCallLog.latencyMs}
        else 0
      end), 0)`,
      costUsd: sql<string>`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(apiCallLog)
    .leftJoin(agentRuns, eq(agentRuns.id, apiCallLog.runId))
    .innerJoin(chatMessages, sql`${chatMessages.runId} = ${OWNER_RUN_ID}`)
    .where(
      and(
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.runId),
        // Null usage, or a rollup missing the model breakdown, per-agent split,
        // or model latency needed for output throughput.
        sql`(${chatMessages.usage} is null
          or coalesce(jsonb_array_length(${chatMessages.usage} -> 'models'), 0) = 0
          or coalesce(jsonb_array_length(${chatMessages.usage} -> 'agents'), 0) = 0
          or not (${chatMessages.usage} ? 'modelLatencyMs'))`,
      ),
    )
    .groupBy(chatMessages.id, apiCallLog.kind, CALL_ROLE, SUB_ID, MODEL);
}

/**
 * Bucket the per-(message, model) groups by message, then fold each bucket into
 * one validated ChatMessageUsage via the shared {@link foldModelUsage} — the
 * same rollup the live `aggregateRunUsage` runs, so the backfill can't drift
 * from the finalize path.
 */
function foldUsage(groups: Awaited<ReturnType<typeof loadGroups>>): Map<string, ChatMessageUsage> {
  const rowsByMessage = new Map<string, Awaited<ReturnType<typeof loadGroups>>>();
  for (const row of groups) {
    const rows = rowsByMessage.get(row.messageId) ?? [];
    rows.push(row);
    rowsByMessage.set(row.messageId, rows);
  }
  const byMessage = new Map<string, ChatMessageUsage>();
  for (const [messageId, rows] of rowsByMessage) {
    byMessage.set(messageId, foldModelUsage(rows));
  }
  return byMessage;
}

async function main(): Promise<void> {
  const groups = await loadGroups();
  const byMessage = foldUsage(groups);

  let written = 0;
  let skipped = 0;
  for (const [messageId, raw] of byMessage) {
    // Validate the fold against the wire schema before it becomes a durable row.
    const parsed = chatMessageUsageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.calls === 0) {
      skipped++;
      continue;
    }
    const usage = parsed.data;
    const models = usage.models.map((m) => `${m.model}×${m.calls}`).join(", ");
    const workers = usage.agents.filter((a) => a.subId !== null).length;
    console.log(
      `${COMMIT ? "write" : "would write"} ${messageId} — ${usage.calls} calls, ` +
        `$${usage.costUsd.toFixed(4)}, in=${usage.inputTokens} out=${usage.outputTokens} — [${models}]` +
        (workers > 0 ? ` — +${workers} worker(s)` : ""),
    );
    if (COMMIT) {
      // Bump rowVersion + updatedAt so the change is delivered on the next
      // Replicache pull (the synced read model carries `usage`).
      await db()
        .update(chatMessages)
        .set({
          usage,
          rowVersion: sql`${chatMessages.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, messageId));
    }
    written++;
  }

  console.log(
    `\n${COMMIT ? "backfilled" : "dry-run"}: ${written} message(s) ${COMMIT ? "updated" : "to update"}` +
      `${skipped > 0 ? `, ${skipped} skipped (no billable calls)` : ""}.` +
      (COMMIT ? "" : "\nRe-run with --commit to persist."),
  );
  await closeConnections();
}

void main();
