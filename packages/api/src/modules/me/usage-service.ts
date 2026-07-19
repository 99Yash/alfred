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
 * Settings → Usage aggregations over `api_call_log` (per-call cost log; one row
 * per billable external request, `cost_usd` snapshot at write time). Runs are
 * recovered by grouping on `run_id` and left-joining `agent_runs` to read the
 * owning run's `workflow_slug` — the category discriminator (ADR-0015/0027).
 *
 * Scope notes:
 *  - Only rows with a non-null `run_id` become activity rows; ad-hoc probe
 *    calls (no run) still count in the summary totals but have no run to show.
 *  - `cost_usd`/token sums arrive from Postgres as strings — always coerce.
 *  - Single-user app: these read paths are called rarely (a settings tab), so
 *    correctness and clarity win over shaving the extra count round-trip.
 */

/**
 * Frozen workflow-slug → category map. These slugs are stable run identifiers
 * defined across the workflow modules (`CHAT_TURN_WORKFLOW_SLUG`,
 * `DAILY_BRIEFING_WORKFLOW_SLUG`, …); duplicated here as literals rather than
 * importing ten heavy workflow modules into this lightweight read service.
 * Changing a slug is already a migration-class event, so the coupling is safe.
 */
export const SLUG_CATEGORY: Record<string, UsageRunCategory> = {
  "__chat-turn__": "chat",
  "daily-briefing": "briefing",
  "morning-briefing": "briefing",
  "email-triage": "triage",
  "cold-start-research": "cold_start",
  "learn-skill": "skill",
  "skill-documentation": "skill",
  "memory-extraction": "memory",
  "__chat-memory-capture__": "memory",
  "__user-authored-brief__": "sub_agent",
};

/** Every slug the map above recognizes — the complement is a user workflow. */
const KNOWN_SLUGS = Object.keys(SLUG_CATEGORY);

/** Coerce a Postgres aggregate (string | number | null) to a finite number. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce a timestamp aggregate to an ISO string. `min(created_at)` comes back
 * as a `Date` under node-postgres but a string under some drivers/raw casts —
 * normalize either shape (invalid → epoch, never throws).
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** A run's category: mapped slug, user-workflow, or uncategorized (no run row). */
function categoryOf(workflowSlug: string | null): UsageRunCategory {
  if (workflowSlug === null) return "uncategorized";
  return SLUG_CATEGORY[workflowSlug] ?? "workflow";
}

/**
 * Display label for an activity row. Briefings split morning/evening from the
 * run's `state.slot` (best-effort — the column is untyped jsonb); everything
 * else uses a fixed category label or the raw user-workflow slug.
 */
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

/** WHERE predicate selecting the runs that fall in one category. */
function categoryPredicate(category: UsageRunCategory): SQL {
  switch (category) {
    case "workflow":
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

/** Period totals for the overview strip. `end` is exclusive. */
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

/** Per-category cards for the window. Sums reconcile to the overview totals. */
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

  // Group by the raw slug, then fold slugs into categories in JS. Grouping on a
  // SQL CASE would trip Postgres's ungrouped-column check. Every call in the
  // window lands in exactly one card: a null slug (LEFT JOIN miss — an orphaned
  // run_id, or an ad-hoc call with no run_id at all) folds into `uncategorized`.
  // We deliberately DON'T filter to non-null run_id here: the overview strip
  // sums every call, so excluding run-less calls would make the cards total
  // less than the headline spend with nothing on screen explaining the gap.
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

/** Paginated per-run activity rows, filtered by category and sorted. */
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
    // Activity rows are runs; ad-hoc no-run calls have nothing to group on.
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
  // Map the direction to a literal fragment rather than interpolating the
  // caller's string with sql.raw — keeps this exported function injection-safe
  // even if a future caller passes an unsanitized `sortDir`.
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
    // Group by the run + `agent_runs.id` (its PK): Postgres then lets us select
    // `workflow_slug`/`state` as functionally dependent on the PK instead of
    // forcing the whole `state` jsonb blob into the GROUP BY hash key.
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

/** Per-(run, model) call counts for the runs on the current page, busiest first. */
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
    // Same [start, end) window as the run aggregates above — without it a run
    // whose calls straddle the window boundary would count models it only used
    // outside the queried period, and `sum(models.calls)` would exceed its
    // in-window `calls`.
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
