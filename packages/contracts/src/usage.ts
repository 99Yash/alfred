import { z } from "zod";
import { enumGuard } from "./guards";

/** Settings > Usage dashboard. The server groups `api_call_log` by `run_id`; cost is USD at write time. */

/**
 * Run category, derived on the server from `agent_runs.workflow_slug`. A run `label` can be finer.
 * `uncategorized` covers calls with no `run_id` and unknown slugs.
 */
export const USAGE_RUN_CATEGORIES = [
  "chat",
  "briefing",
  "triage",
  "reply_drafting",
  "cold_start",
  "skill",
  "memory",
  "sub_agent",
  "workflow",
  "uncategorized",
] as const;

export const usageRunCategorySchema = z.enum(USAGE_RUN_CATEGORIES);

export type UsageRunCategory = (typeof USAGE_RUN_CATEGORIES)[number];

export const isUsageRunCategory = enumGuard(USAGE_RUN_CATEGORIES);

/** One served model within a run: its id and how many calls it answered. */
export const usageModelBreakdownSchema = z.object({
  model: z.string(),
  calls: z.number().int().nonnegative(),
});

export type UsageModelBreakdown = z.infer<typeof usageModelBreakdownSchema>;

/** Period totals. `periodStart` and `periodEnd` echo the queried window (end exclusive). */
export const usageSummarySchema = z.object({
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /** Distinct runs with a `run_id`. */
  runs: z.number().int().nonnegative(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** `tokens` is input plus output; input includes cached tokens. */
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

/** One agent run, folded from its `api_call_log` rows. */
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

/** Server-sortable activity columns. */
export const usageSortFieldValues = ["createdAt", "costUsd"] as const;

export type UsageSortField = (typeof usageSortFieldValues)[number];

export const usageSortDirValues = ["asc", "desc"] as const;

export type UsageSortDir = (typeof usageSortDirValues)[number];

export const USAGE_ACTIVITY_MAX_PAGE_SIZE = 100;

export const USAGE_ACTIVITY_DEFAULT_PAGE_SIZE = 20;
