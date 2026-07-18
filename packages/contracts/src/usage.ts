import { z } from "zod";

/**
 * Browser-safe contracts for the settings → Usage dashboard. The web bundle
 * reads these to render per-run cost/token spend without importing `@alfred/db`
 * or `@alfred/ai`. The server aggregates `api_call_log` (per-call cost log, one
 * row per billable external request) grouped by `run_id`, joined to
 * `agent_runs` to recover each run's category.
 *
 * Alfred has no billing/credits abstraction — this surface reports raw *cost*
 * (USD, snapshot at write time) and *tokens*, not a paid-plan quota.
 */

/**
 * Coarse run category, derived server-side from `agent_runs.workflow_slug`
 * (+ `trigger.kind`). It is the stable filter/color key; the human-readable
 * `label` on a run may be finer (e.g. "Morning briefing" vs "Evening briefing",
 * or a specific skill/workflow name) than the category bucket.
 *
 *   - `chat`          — a boss chat turn (`__chat-turn__`).
 *   - `briefing`      — morning or evening daily briefing (`daily-briefing`).
 *   - `triage`        — email triage run (`email-triage`).
 *   - `cold_start`    — cold-start onboarding research.
 *   - `skill`         — a skill run (learn-skill / skill-documentation).
 *   - `memory`        — memory extraction / chat-memory capture.
 *   - `sub_agent`     — a spawned sub-agent brief (billed on its own run).
 *   - `workflow`      — a user-authored workflow run.
 *   - `uncategorized` — calls with no `run_id` (ad-hoc probes, cold-start
 *                       research fragments) or an unrecognized slug.
 */
export const USAGE_RUN_CATEGORIES = [
  "chat",
  "briefing",
  "triage",
  "cold_start",
  "skill",
  "memory",
  "sub_agent",
  "workflow",
  "uncategorized",
] as const;

export const usageRunCategorySchema = z.enum(USAGE_RUN_CATEGORIES);
export type UsageRunCategory = (typeof USAGE_RUN_CATEGORIES)[number];

export function isUsageRunCategory(value: unknown): value is UsageRunCategory {
  return typeof value === "string" && (USAGE_RUN_CATEGORIES as readonly string[]).includes(value);
}

/** One served model within a run: its id and how many calls it answered. */
export const usageModelBreakdownSchema = z.object({
  model: z.string(),
  calls: z.number().int().nonnegative(),
});
export type UsageModelBreakdown = z.infer<typeof usageModelBreakdownSchema>;

/**
 * Period totals for the overview strip. `periodStart`/`periodEnd` are ISO
 * instants bounding the queried window (`end` exclusive), echoed back so the
 * client can label the range it actually got.
 */
export const usageSummarySchema = z.object({
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /** Distinct billed agent runs in the window (rows with a `run_id`). */
  runs: z.number().int().nonnegative(),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Per-category rollup card. `tokens` = input + output (cache-inclusive input). */
export const usageCategoryBreakdownSchema = z.object({
  category: usageRunCategorySchema,
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type UsageCategoryBreakdown = z.infer<typeof usageCategoryBreakdownSchema>;

export const usageBreakdownSchema = z.object({
  categories: z.array(usageCategoryBreakdownSchema),
});
export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;

/**
 * One row in the activity table: a single agent run, folded from its
 * `api_call_log` rows. `label` is the display name (category-derived, possibly
 * finer than `category`); `models` lists which providers/models served it.
 */
export const usageActivityRunSchema = z.object({
  runId: z.string(),
  createdAt: z.string(),
  category: usageRunCategorySchema,
  label: z.string(),
  workflowSlug: z.string().nullable(),
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  models: z.array(usageModelBreakdownSchema),
});
export type UsageActivityRun = z.infer<typeof usageActivityRunSchema>;

export const usageActivityResultSchema = z.object({
  runs: z.array(usageActivityRunSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type UsageActivityResult = z.infer<typeof usageActivityResultSchema>;

/** The only server-sortable activity column. Everything else sorts by recency. */
export const usageSortFieldValues = ["createdAt", "costUsd"] as const;
export type UsageSortField = (typeof usageSortFieldValues)[number];

export const usageSortDirValues = ["asc", "desc"] as const;
export type UsageSortDir = (typeof usageSortDirValues)[number];

/** Pagination + filter/sort bounds shared by the route validator and client. */
export const USAGE_ACTIVITY_MAX_PAGE_SIZE = 100;
export const USAGE_ACTIVITY_DEFAULT_PAGE_SIZE = 20;
