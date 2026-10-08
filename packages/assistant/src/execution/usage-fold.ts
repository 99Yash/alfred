import type { ChatEffort, ChatMessageUsage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, apiCallLog } from "@alfred/db/schemas";
import { inArray, sql } from "drizzle-orm";
import { subAgentParentRunIdMatches } from "./sub-agent-metadata";

/**
 * A `withFallback` row: `model` was moved to the served model. A dated alias of the requested
 * model is not moved, so it does not count as degraded.
 */
export const DEGRADED = sql<boolean>`coalesce((${apiCallLog.responseMeta}->>'servedModelId') = ${apiCallLog.model}, false)`;

/** The requested model of a degraded row. Older rows lack it. */
export const REQUESTED_MODEL = sql<string | null>`${apiCallLog.responseMeta}->>'requestedModelId'`;

/** One (agent, model) group. `subId` is null for the boss. Postgres sums arrive as strings. */
export interface ModelUsageGroup {
  kind: string;
  role: string | null;
  model: string;
  subId: string | null;
  inputTokens: string | number;
  outputTokens: string | number;
  cachedInputTokens: string | number;
  /** Absent means "not recorded", never zero. */
  cacheWriteInputTokens?: string | number | undefined;
  modelLatencyMs: string | number;
  costUsd: string | number;
  calls: string | number;
  /** A `withFallback` cascade fired. Absent means not degraded. */
  degraded?: boolean | undefined;
  requestedModel?: string | null | undefined;
}

/**
 * Fold groups into one {@link ChatMessageUsage} with per-model and per-agent splits.
 * Re-bucket both here: the query groups by agent and model together.
 */
export function foldModelUsage(
  groups: readonly ModelUsageGroup[],
  effort: ChatEffort = "medium",
): ChatMessageUsage {
  const usage: ChatMessageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    // Null unless some group has it, so it reads as "not recorded", not zero.
    cacheWriteInputTokens: null,
    modelLatencyMs: 0,
    costUsd: 0,
    calls: 0,
    models: [],
    agents: [],
    effort,
  };

  const callsByModel = new Map<
    string,
    { calls: number; fallbackCalls: number; primary: string | null }
  >();

  // `null` is the boss, so a child named "boss" cannot collide with it.
  const byAgent = new Map<string | null, { calls: number; costUsd: number }>();

  for (const group of groups) {
    // Background work such as title generation shares the run id; count only the boss and
    // sub-agents.
    if (group.kind !== "llm" || (group.role !== "boss" && group.role !== "sub_agent")) continue;
    const calls = Number(group.calls) || 0;
    const costUsd = Number(group.costUsd) || 0;
    usage.inputTokens += Number(group.inputTokens) || 0;
    usage.outputTokens += Number(group.outputTokens) || 0;
    usage.cachedInputTokens += Number(group.cachedInputTokens) || 0;

    if (group.cacheWriteInputTokens !== undefined) {
      usage.cacheWriteInputTokens =
        (usage.cacheWriteInputTokens ?? 0) + (Number(group.cacheWriteInputTokens) || 0);
    }

    usage.modelLatencyMs += Number(group.modelLatencyMs) || 0;
    usage.costUsd += costUsd;
    usage.calls += calls;
    const model = callsByModel.get(group.model) ?? { calls: 0, fallbackCalls: 0, primary: null };
    model.calls += calls;

    if (group.degraded === true) {
      model.fallbackCalls += calls;
      model.primary ??= group.requestedModel ?? null;
    }

    callsByModel.set(group.model, model);
    const agent = byAgent.get(group.subId) ?? { calls: 0, costUsd: 0 };
    agent.calls += calls;
    agent.costUsd += costUsd;
    byAgent.set(group.subId, agent);
  }

  usage.models = [...callsByModel]
    .map(([model, totals]) => ({
      model,
      calls: totals.calls,
      fallback:
        totals.fallbackCalls > 0 ? { primary: totals.primary, calls: totals.fallbackCalls } : null,
    }))
    .filter((m) => m.calls > 0)
    .sort((a, b) => b.calls - a.calls);
  usage.agents = [...byAgent]
    .map(([subId, totals]) => ({ subId, ...totals }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return usage;
}

/**
 * The boss run and its children, with their `subId`. Sub-agents cannot spawn, so one level is the
 * whole tree.
 */
async function listTurnRuns(runId: string): Promise<Map<string, string | null>> {
  const children = await db()
    .select({
      id: agentRuns.id,
      subId: sql<string | null>`${agentRuns.metadata}->'subAgent'->>'subId'`,
    })
    .from(agentRuns)
    .where(subAgentParentRunIdMatches(runId));

  const runs = new Map<string, string | null>([[runId, null]]);

  for (const child of children) {
    // Never merge an unlabeled child's spend into the boss's.
    runs.set(child.id, child.subId ?? "sub-agent");
  }

  return runs;
}

/**
 * A chat turn's usage and cost, sub-agent runs included: a delegating turn spends most there.
 * Metering writes are fire-and-forget, so the last call can be missing. Null when nothing was
 * logged.
 */
export async function aggregateRunUsage(
  runId: string,
  effort: ChatEffort = "medium",
): Promise<ChatMessageUsage | null> {
  const runs = await listTurnRuns(runId);

  const rows = await db()
    .select({
      runId: apiCallLog.runId,
      kind: apiCallLog.kind,
      role: sql<string | null>`${apiCallLog.requestMeta}->>'role'`,
      model: sql<string>`coalesce(${apiCallLog.model}, 'unknown')`,
      degraded: DEGRADED,
      requestedModel: REQUESTED_MODEL,
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
    .where(inArray(apiCallLog.runId, [...runs.keys()]))
    .groupBy(
      apiCallLog.runId,
      apiCallLog.kind,
      sql`${apiCallLog.requestMeta}->>'role'`,
      apiCallLog.model,
      DEGRADED,
      REQUESTED_MODEL,
    );

  if (rows.length === 0) return null;

  const usage = foldModelUsage(
    rows.map((row) => ({
      ...row,
      subId: row.runId === null ? null : (runs.get(row.runId) ?? null),
    })),
    effort,
  );

  return usage.calls === 0 ? null : usage;
}
