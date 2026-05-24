import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * Per-call cost log for every billable external request (LLM, embedding,
 * web search, transcription, future tool APIs). Single source of truth
 * per ADR-0015: one row per terminal attempt; aggregates derive from
 * this table via materialized views or scheduled rollups (not yet built).
 *
 * `cost_usd` is computed from `model_prices` at WRITE time and snapshot
 * here — later price corrections never silently rewrite history.
 *
 * Attribution columns are nullable so we can meter calls outside of an
 * agent run (cold-start research, ad-hoc test calls). The `kind`
 * discriminator lets us reuse this table for non-LLM costs (embeddings,
 * web_search) without per-kind tables. user_id FK cascades on delete —
 * single-user app, no value in keeping cost history past the user.
 */
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    /** Snapshot at write time. numeric(12,8) keeps fractions of a cent across orders of magnitude. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    stepId: text("step_id"),
    attempt: integer("attempt"),
    messageId: text("message_id"),
    /** Trimmed model params + retry/attempt count + idempotency-key. */
    requestMeta: jsonb("request_meta"),
    /** finish_reason, usage block, tool_calls count, raw provider response id. */
    responseMeta: jsonb("response_meta"),
    error: jsonb("error"),
  },
  (t) => [
    index("api_call_log_run_idx").on(t.runId, t.id),
    index("api_call_log_user_created_idx").on(t.userId, t.createdAt),
    index("api_call_log_kind_created_idx").on(t.kind, t.createdAt),
  ],
);

/**
 * Time-versioned per-(provider, model) pricing. Lookups select the row
 * with the largest `valid_from` ≤ now() — old rows stay forever so
 * historical writes resolve to their original snapshot price.
 *
 * Seeded by `pnpm db:sync-prices` from models.dev (ADR-0016 source-of-
 * truth). New deploys can change pricing without redeploys to code.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Effective from this timestamp; lookups pick the latest ≤ now(). */
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    /** Cost per 1,000,000 input tokens, USD. */
    inputPerMtok: numeric("input_per_mtok", { precision: 12, scale: 6 }).notNull(),
    /** Cost per 1,000,000 output tokens, USD. */
    outputPerMtok: numeric("output_per_mtok", { precision: 12, scale: 6 }).notNull(),
    /** Cost per 1,000,000 cached-read input tokens (Anthropic prompt cache, etc.). NULL if unsupported. */
    cachedInputPerMtok: numeric("cached_input_per_mtok", { precision: 12, scale: 6 }),
    /** Cost per call for fixed-fee endpoints (Perplexity, transcription). NULL when token-based. */
    perCallUsd: numeric("per_call_usd", { precision: 12, scale: 6 }),
    /** Model context window in tokens, populated from models.dev capability metadata when available. */
    contextWindow: integer("context_window"),
    /** Free-form provenance: source URL, models.dev id, etc. */
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("model_prices_versioned_idx").on(t.provider, t.model, t.validFrom),
    index("model_prices_lookup_idx").on(t.provider, t.model, t.validFrom),
  ],
);
