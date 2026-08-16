import type { ChatMessageUsage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, apiCallLog } from "@alfred/db/schemas";
import { inArray, sql } from "drizzle-orm";
import { subAgentParentRunIdMatches } from "./sub-agent-metadata";

/**
 * One `api_call_log` group summed for a single (agent, model) pair within a
 * turn. `subId` names the agent that made the calls: `null` for the boss run,
 * the child's `subId` for a sub-agent. The `sum`/`count` aggregates arrive from
 * Postgres as strings, so every numeric field also accepts a `string` —
 * {@link foldModelUsage} coerces with `Number(...)` and treats `NaN`/empty as
 * `0`.
 */
export interface ModelUsageGroup {
  model: string;
  subId: string | null;
  inputTokens: string | number;
  outputTokens: string | number;
  cachedInputTokens: string | number;
  costUsd: string | number;
  calls: string | number;
}

/**
 * Fold per-(agent, model) usage groups into one {@link ChatMessageUsage}: sum
 * the turn totals, carry a per-model `{ model, calls }` breakdown sorted busiest
 * first, and carry a per-agent `{ subId, calls, costUsd }` split sorted most
 * expensive first. The single home for the `(model, tokens, cost)` rollup shape
 * — shared by the live finalize path ({@link aggregateRunUsage}) and the one-off
 * backfill script so the two can't drift.
 *
 * Both breakdowns are re-bucketed here rather than trusted from the query: one
 * model can serve two agents, and one agent can be served by two models, so the
 * caller's GROUP BY is the cross product of the two.
 */
export function foldModelUsage(groups: readonly ModelUsageGroup[]): ChatMessageUsage {
  const usage: ChatMessageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    calls: 0,
    models: [],
    agents: [],
  };
  const callsByModel = new Map<string, number>();
  // Keyed on subId with a sentinel for the boss, because `null` is a legitimate
  // agent here and Map keys distinguish it from a child literally named "boss".
  const byAgent = new Map<string | null, { calls: number; costUsd: number }>();
  for (const group of groups) {
    const calls = Number(group.calls) || 0;
    const costUsd = Number(group.costUsd) || 0;
    usage.inputTokens += Number(group.inputTokens) || 0;
    usage.outputTokens += Number(group.outputTokens) || 0;
    usage.cachedInputTokens += Number(group.cachedInputTokens) || 0;
    usage.costUsd += costUsd;
    usage.calls += calls;
    callsByModel.set(group.model, (callsByModel.get(group.model) ?? 0) + calls);
    const agent = byAgent.get(group.subId) ?? { calls: 0, costUsd: 0 };
    agent.calls += calls;
    agent.costUsd += costUsd;
    byAgent.set(group.subId, agent);
  }
  usage.models = [...callsByModel]
    .map(([model, calls]) => ({ model, calls }))
    .filter((m) => m.calls > 0)
    .sort((a, b) => b.calls - a.calls);
  usage.agents = [...byAgent]
    .map(([subId, totals]) => ({ subId, ...totals }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return usage;
}

/**
 * Every run that bills into one chat turn: the boss run itself plus each
 * sub-agent it spawned, each paired with the `subId` the split is labeled by.
 * Keyed on the same trusted `subAgent.parentRunId` metadata pointer
 * `spawnSubAgent` stamps and `listSpawnedChildRuns` reads.
 *
 * Sub-agents cannot spawn sub-agents (`system.spawn_sub_agent` is
 * `callers: ["boss"]`), so one level of children is the whole tree — no
 * recursive walk is needed here.
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
    // A child without a readable `subId` still spent money; label it so its
    // slice of the split is never silently merged into the boss's.
    runs.set(child.id, child.subId ?? "sub-agent");
  }
  return runs;
}

/**
 * Roll up a chat turn's token usage + cost from `api_call_log` for the dev usage
 * readout. Covers the boss `runId` AND every sub-agent run it spawned: children
 * are separate runs billed under their own ids, and a turn that delegates spends
 * most of its money there (see `.lessons/model-cost-recompute-from-tokens.md`).
 * The fold keeps the money split per agent so the readout can show it.
 *
 * Called at finalize, after the ADR-0073 join guard has held the turn open until
 * every spawned child is terminal, so the children's rows are already written.
 * Still best-effort: metering rows are written fire-and-forget, so a straggler
 * write can undercount the final call. Returns null when the turn logged
 * nothing.
 *
 * Lives beside {@link foldModelUsage} rather than with the turn closure that
 * calls it: the GROUP BY and the fold are one shape, and the backfill script
 * runs the same pair widened by message id. Changing what usage records means
 * changing this file.
 */
export async function aggregateRunUsage(runId: string): Promise<ChatMessageUsage | null> {
  const runs = await listTurnRuns(runId);
  // Grouped by run and model: by model so the readout can name every model that
  // served the turn (and catch a silent Anthropic→Gemini fallback), by run so
  // each agent's spend stays attributable. The turn totals are summed back
  // across the groups in JS.
  const rows = await db()
    .select({
      runId: apiCallLog.runId,
      model: sql<string>`coalesce(${apiCallLog.model}, 'unknown')`,
      inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(apiCallLog)
    .where(inArray(apiCallLog.runId, [...runs.keys()]))
    .groupBy(apiCallLog.runId, apiCallLog.model);
  if (rows.length === 0) return null;
  const usage = foldModelUsage(
    rows.map((row) => ({
      ...row,
      subId: row.runId === null ? null : (runs.get(row.runId) ?? null),
    })),
  );
  return usage.calls === 0 ? null : usage;
}
