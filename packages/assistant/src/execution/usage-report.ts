import {
  getPath,
  USAGE_ACTIVITY_MAX_PAGE_SIZE,
  type UsageActivityResult,
  type UsageActivityRun,
  type UsageBreakdown,
  type UsageCategoryBreakdown,
  type UsageModelBreakdown,
  type UsageRunCategory,
  type UsageSortDir,
  type UsageSortField,
  type UsageSummary,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, apiCallLog } from "@alfred/db/schemas";
import { and, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Settings > Usage, from `api_call_log`. The run's `workflow_slug` gives the category.
 * Calls with no run count in the totals but have no activity row. Postgres sums arrive as strings.
 */

/**
 * Slug literals, to avoid importing every workflow module. A slug change already needs a migration.
 */
export const SLUG_CATEGORY = {
  "__chat-turn__": "chat",
  "daily-briefing": "briefing",
  "morning-briefing": "briefing",
  "email-triage": "triage",
  "reply-drafting": "reply_drafting",
  "cold-start-research": "cold_start",
  "learn-skill": "skill",
  "skill-documentation": "skill",
  "memory-extraction": "memory",
  "__chat-memory-capture__": "memory",
  "__user-authored-brief__": "sub_agent",
} satisfies Record<string, UsageRunCategory>;

/** Any other slug is a user workflow. */
const KNOWN_SLUGS = Object.keys(SLUG_CATEGORY);

function num(value: unknown): number {
  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}

/** Accepts a `Date` or a string, since drivers differ. Invalid input gives the epoch. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));

  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function categoryOf(workflowSlug: string | null): UsageRunCategory {
  if (workflowSlug === null) return "uncategorized";

  return Object.entries(SLUG_CATEGORY).find(([slug]) => slug === workflowSlug)?.[1] ?? "workflow";
}

/** Briefings read morning or evening from the untyped `state.slot`. */
function labelOf(category: UsageRunCategory, workflowSlug: string | null, state: unknown): string {
  switch (category) {
    case "chat":
      return "Chat turn";
    case "briefing": {
      const slot = getPath(state, "slot") ?? getPath(state, "input", "slot");

      if (slot === "evening") return "Evening briefing";

      if (slot === "morning") return "Morning briefing";

      return "Daily briefing";
    }

    case "triage":
      return "Email triage";
    case "reply_drafting":
      return "Reply draft";
    case "cold_start":
      return "Cold-start research";
    case "skill":
      return workflowSlug === "skill-documentation" ? "Skill documentation" : "Skill";
    case "memory":
      return "Memory";
    case "sub_agent":
      return "Sub-agent";
    case "workflow":
      return workflowSlug ?? "Workflow";
    case "uncategorized":
      return "Uncategorized";
  }
}

function categoryPredicate(category: UsageRunCategory): SQL {
  switch (category) {
    case "workflow":
      // SAFETY: and() with two defined args always returns a SQL node.
      return and(isNotNull(agentRuns.id), notInArray(agentRuns.workflowSlug, KNOWN_SLUGS)) as SQL;
    case "uncategorized":
      return isNull(agentRuns.id);
    default: {
      const slugs = Object.entries(SLUG_CATEGORY)
        .filter(([, c]) => c === category)
        .map(([slug]) => slug);

      return inArray(agentRuns.workflowSlug, slugs);
    }
  }
}

/** `end` is exclusive. */
export async function getUsageSummary(
  userId: string,
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const rows = await db()
    .select({
      cost: sql`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      input: sql`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      output: sql`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cached: sql`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      calls: sql`count(*)`,
      runs: sql`count(distinct ${apiCallLog.runId})`,
    })
    .from(apiCallLog)
    .where(
      and(
        eq(apiCallLog.userId, userId),
        gte(apiCallLog.createdAt, start),
        lt(apiCallLog.createdAt, end),
      ),
    );

  const r = rows[0];

  return {
    costUsd: num(r?.cost),
    inputTokens: num(r?.input),
    outputTokens: num(r?.output),
    cachedInputTokens: num(r?.cached),
    calls: num(r?.calls),
    runs: num(r?.runs),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

/** The category sums add up to the overview totals. */
export async function getUsageBreakdown(
  userId: string,
  start: Date,
  end: Date,
): Promise<UsageBreakdown> {
  const windowWhere = and(
    eq(apiCallLog.userId, userId),
    gte(apiCallLog.createdAt, start),
    lt(apiCallLog.createdAt, end),
  );

  // Group by slug and fold in JS; a SQL CASE trips the ungrouped-column check.
  // Keep calls with no run (as `uncategorized`), or the cards would not add up to the headline
  // spend.
  const slugRows = await db()
    .select({
      workflowSlug: agentRuns.workflowSlug,
      cost: sql`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      tokens: sql`coalesce(sum(${apiCallLog.inputTokens}) + sum(${apiCallLog.outputTokens}), 0)`,
      runs: sql`count(distinct ${apiCallLog.runId})`,
      calls: sql`count(*)`,
    })
    .from(apiCallLog)
    .leftJoin(agentRuns, eq(agentRuns.id, apiCallLog.runId))
    .where(windowWhere)
    .groupBy(agentRuns.workflowSlug);

  const byCategory = new Map<UsageRunCategory, UsageCategoryBreakdown>();

  for (const row of slugRows) {
    const category = categoryOf(row.workflowSlug ?? null);

    const acc = byCategory.get(category) ?? {
      category,
      costUsd: 0,
      tokens: 0,
      runs: 0,
      calls: 0,
    };

    acc.costUsd += num(row.cost);
    acc.tokens += num(row.tokens);
    acc.runs += num(row.runs);
    acc.calls += num(row.calls);
    byCategory.set(category, acc);
  }

  const categories: UsageCategoryBreakdown[] = [...byCategory.values()].sort(
    (a, b) => b.costUsd - a.costUsd,
  );

  return { categories };
}

export interface UsageActivityQuery {
  start: Date;
  end: Date;
  page: number;
  pageSize: number;
  categories?: ReadonlyArray<UsageRunCategory>;
  sortField: UsageSortField;
  sortDir: UsageSortDir;
}

export async function getUsageActivity(
  userId: string,
  q: UsageActivityQuery,
): Promise<UsageActivityResult> {
  const page = Math.max(1, q.page);
  const pageSize = Math.min(USAGE_ACTIVITY_MAX_PAGE_SIZE, Math.max(1, q.pageSize));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [
    eq(apiCallLog.userId, userId),
    gte(apiCallLog.createdAt, q.start),
    lt(apiCallLog.createdAt, q.end),
    isNotNull(apiCallLog.runId),
  ];

  if (q.categories && q.categories.length > 0) {
    const preds = q.categories.map(categoryPredicate);
    const combined = preds.length === 1 ? preds[0] : or(...preds);

    if (combined) filters.push(combined);
  }

  const where = and(...filters);

  const countRows = await db()
    .select({ n: sql`count(distinct ${apiCallLog.runId})` })
    .from(apiCallLog)
    .leftJoin(agentRuns, eq(agentRuns.id, apiCallLog.runId))
    .where(where);

  const total = num(countRows[0]?.n);

  const createdExpr = sql<string>`min(${apiCallLog.createdAt})`;
  const costExpr = sql`coalesce(sum(${apiCallLog.costUsd}), 0)`;
  // A literal fragment, never sql.raw of caller input.
  const dir = q.sortDir === "asc" ? sql`asc` : sql`desc`;

  const orderExpr =
    q.sortField === "costUsd" ? sql`${costExpr} ${dir}` : sql`${createdExpr} ${dir}`;

  const runRows = await db()
    .select({
      runId: apiCallLog.runId,
      createdAt: createdExpr,
      cost: costExpr,
      input: sql`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      output: sql`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cached: sql`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      calls: sql`count(*)`,
      workflowSlug: agentRuns.workflowSlug,
      state: agentRuns.state,
    })
    .from(apiCallLog)
    .leftJoin(agentRuns, eq(agentRuns.id, apiCallLog.runId))
    .where(where)
    // Grouping by the PK lets us select `state` without hashing the jsonb.
    .groupBy(apiCallLog.runId, agentRuns.id)
    .orderBy(orderExpr)
    .limit(pageSize)
    .offset(offset);

  const runIds = runRows.map((r) => r.runId).filter((id): id is string => id !== null);
  const modelsByRun = await modelsForRuns(userId, runIds, q.start, q.end);

  const runs: UsageActivityRun[] = runRows.map((row) => {
    const workflowSlug = row.workflowSlug ?? null;
    const category = categoryOf(workflowSlug);

    return {
      runId: row.runId ?? "",
      createdAt: toIso(row.createdAt),
      category,
      label: labelOf(category, workflowSlug, row.state),
      workflowSlug,
      costUsd: num(row.cost),
      inputTokens: num(row.input),
      outputTokens: num(row.output),
      cachedInputTokens: num(row.cached),
      calls: num(row.calls),
      models: modelsByRun.get(row.runId ?? "") ?? [],
    };
  });

  return { runs, total, page, pageSize };
}

/** Calls per run and model for the current page, busiest first. */
async function modelsForRuns(
  userId: string,
  runIds: ReadonlyArray<string>,
  start: Date,
  end: Date,
): Promise<Map<string, UsageModelBreakdown[]>> {
  const byRun = new Map<string, UsageModelBreakdown[]>();

  if (runIds.length === 0) return byRun;

  const rows = await db()
    .select({
      runId: apiCallLog.runId,
      model: apiCallLog.model,
      calls: sql`count(*)`,
    })
    .from(apiCallLog)
    // Same window as the run totals, or model counts could exceed a run's calls.
    .where(
      and(
        eq(apiCallLog.userId, userId),
        gte(apiCallLog.createdAt, start),
        lt(apiCallLog.createdAt, end),
        inArray(apiCallLog.runId, [...runIds]),
      ),
    )
    .groupBy(apiCallLog.runId, apiCallLog.model);

  for (const row of rows) {
    if (row.runId === null) continue;
    const list = byRun.get(row.runId) ?? [];
    list.push({ model: row.model, calls: num(row.calls) });
    byRun.set(row.runId, list);
  }

  for (const list of byRun.values()) list.sort((a, b) => b.calls - a.calls);

  return byRun;
}
