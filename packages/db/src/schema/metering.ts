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
 * One row per billable external call, LLM or not (ADR-0015).
 * `cost_usd` is priced at write time, so later price fixes do not rewrite history.
 * Run columns are nullable so calls outside an agent run can be metered too.
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
    /** Prompt tokens written to a paid provider cache. */
    cacheWriteInputTokens: integer("cache_write_input_tokens"),
    /** numeric(12,8) keeps fractions of a cent. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    stepId: text("step_id"),
    attempt: integer("attempt"),
    messageId: text("message_id"),
    requestMeta: jsonb("request_meta"),
    responseMeta: jsonb("response_meta"),
    error: jsonb("error"),
    /**
     * HTTP status of a failed call. NULL on success and on a failure with no status.
     * The gateway returns two 429s with the same message, so the message alone is not enough.
     */
    statusCode: integer("status_code"),
    /**
     * Failed-call error body, redacted and truncated. Only this body tells the two gateway 429s apart.
     * It can still hold user text (a 400 echo, a content-filter hit), and the table has no retention yet.
     */
    responseBody: text("response_body"),
  },
  (t) => [
    index("api_call_log_run_idx").on(t.runId, t.id),
    index("api_call_log_user_created_idx").on(t.userId, t.createdAt),
    index("api_call_log_kind_created_idx").on(t.kind, t.createdAt),
  ],
);

/**
 * Time-versioned prices per (provider, model). Lookups take the latest `valid_from` <= now().
 * Old rows stay. `pnpm db:sync-prices` seeds it from models.dev (ADR-0016).
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    /** USD per 1M tokens. */
    inputPerMtok: numeric("input_per_mtok", { precision: 12, scale: 6 }).notNull(),
    outputPerMtok: numeric("output_per_mtok", { precision: 12, scale: 6 }).notNull(),
    /** NULL if the model has no cache reads. */
    cachedInputPerMtok: numeric("cached_input_per_mtok", { precision: 12, scale: 6 }),
    /** NULL falls back to the normal input rate. */
    cacheWriteInputPerMtok: numeric("cache_write_input_per_mtok", { precision: 12, scale: 6 }),
    /** Fixed fee per call. NULL when priced by token. */
    perCallUsd: numeric("per_call_usd", { precision: 12, scale: 6 }),
    contextWindow: integer("context_window"),
    /** Provenance, such as the source URL or models.dev id. */
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("model_prices_versioned_idx").on(t.provider, t.model, t.validFrom)],
);

export type ApiCallLog = typeof apiCallLog.$inferSelect;

export type ModelPrice = typeof modelPrices.$inferSelect;
