/**
 * One-off backfill of `chat_messages.usage` for turns whose rollup is null or missing a field
 * the readout now shows (models, per-agent split, latency, cache writes, tier).
 * Reruns the live `aggregateRunUsage` fold from `api_call_log` (ADR-0015, never pruned),
 * so no Langfuse call is needed. Sub-agent runs fold into the turn that spawned them.
 * A turn with no `api_call_log` rows stays as-is.
 * Dry run by default; pass --commit to write.
 *
 *   $ pnpm --filter @alfred/assistant exec tsx src/scripts/backfill-chat-usage.ts [--commit]
 */

import { db, closeConnections } from "@alfred/db";
import { agentRuns, apiCallLog, chatMessages } from "@alfred/db/schemas";
import { chatMessageUsageSchema, type ChatMessageUsage } from "@alfred/contracts";
import { routeEffort } from "@alfred/ai";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DEGRADED, REQUESTED_MODEL, foldModelUsage } from "@alfred/assistant/execution/usage-fold";

const COMMIT = process.argv.includes("--commit");

/** The turn's boss run. Sub-agents cannot spawn sub-agents, so one hop is enough. */
const OWNER_RUN_ID = sql`coalesce(${agentRuns.metadata}->'subAgent'->>'parentRunId', ${apiCallLog.runId})`;

/** Null for the boss's own run, else the child's `subId`. */
const SUB_ID = sql<
  string | null
>`case when ${apiCallLog.runId} = ${chatMessages.runId} then null else coalesce(${agentRuns.metadata}->'subAgent'->>'subId', 'sub-agent') end`;

const MODEL = sql<string>`coalesce(${apiCallLog.model}, 'unknown')`;

const CALL_ROLE = sql<string | null>`${apiCallLog.requestMeta}->>'role'`;

/** The tier lives on the boss run's metadata. */
const bossRuns = alias(agentRuns, "boss_runs");

/** Null when the boss run row is gone; the fold then uses `standard`, like the live path. */
const TIER = sql<string | null>`${bossRuns.metadata}->>'tier'`;

/**
 * One group per (message, agent, model) in a single scan, driven from `api_call_log`.
 * The `agent_runs` join is LEFT, so spend from a deleted run counts as the boss's.
 */
async function loadGroups(): Promise<
  Array<{
    messageId: string;
    kind: string;
    role: string | null;
    subId: string | null;
    model: string;
    degraded: boolean;
    requestedModel: string | null;
    inputTokens: string;
    outputTokens: string;
    cachedInputTokens: string;
    cacheWriteInputTokens: string;
    modelLatencyMs: string;
    costUsd: string;
    calls: string;
    /** Null when the run row is gone. */
    tier: string | null;
  }>
> {
  return (
    db()
      .select({
        messageId: chatMessages.id,
        kind: apiCallLog.kind,
        role: CALL_ROLE,
        subId: SUB_ID,
        model: MODEL,
        degraded: DEGRADED,
        requestedModel: REQUESTED_MODEL,
        tier: TIER,
        inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
        cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
        cacheWriteInputTokens: sql<string>`coalesce(sum(${apiCallLog.cacheWriteInputTokens}), 0)`,
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
      // LEFT, so a message whose boss run is gone still backfills.
      .leftJoin(bossRuns, eq(bossRuns.id, chatMessages.runId))
      .where(
        and(
          eq(chatMessages.role, "assistant"),
          isNotNull(chatMessages.runId),
          // Null usage, or a rollup missing any field that `api_call_log` and `agent_runs` can rebuild.
          sql`(${chatMessages.usage} is null
          or coalesce(jsonb_array_length(${chatMessages.usage} -> 'models'), 0) = 0
          or coalesce(jsonb_array_length(${chatMessages.usage} -> 'agents'), 0) = 0
          or not (${chatMessages.usage} ? 'modelLatencyMs')
          or ${chatMessages.usage} -> 'cacheWriteInputTokens' is null
          or ${chatMessages.usage} -> 'cacheWriteInputTokens' = 'null'::jsonb
          or not (${chatMessages.usage} ? 'effort'))`,
        ),
      )
      .groupBy(
        chatMessages.id,
        apiCallLog.kind,
        CALL_ROLE,
        SUB_ID,
        MODEL,
        DEGRADED,
        REQUESTED_MODEL,
        TIER,
      )
  );
}

/** Fold each message with the shared {@link foldModelUsage}, so it cannot drift from finalize. */
function foldUsage(groups: Awaited<ReturnType<typeof loadGroups>>): Map<string, ChatMessageUsage> {
  const rowsByMessage = new Map<string, Awaited<ReturnType<typeof loadGroups>>>();

  for (const row of groups) {
    const rows = rowsByMessage.get(row.messageId) ?? [];
    rows.push(row);
    rowsByMessage.set(row.messageId, rows);
  }

  const byMessage = new Map<string, ChatMessageUsage>();

  for (const [messageId, rows] of rowsByMessage) {
    // Anything but `deep` is `standard`, the same rule as the live path.
    const tier = rows[0]?.tier === "deep" ? "deep" : "standard";

    byMessage.set(messageId, foldModelUsage(rows, routeEffort(tier)));
  }

  return byMessage;
}

async function main(): Promise<void> {
  const groups = await loadGroups();
  const byMessage = foldUsage(groups);

  let written = 0;
  let skipped = 0;

  for (const [messageId, raw] of byMessage) {
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
        `$${usage.costUsd.toFixed(4)}, in=${usage.inputTokens} out=${usage.outputTokens} ` +
        `cached=${usage.cachedInputTokens} cold=${usage.cacheWriteInputTokens ?? "?"} effort=${usage.effort} — [${models}]` +
        (workers > 0 ? ` — +${workers} worker(s)` : ""),
    );

    if (COMMIT) {
      // Bump rowVersion so the next Replicache pull delivers it.
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
