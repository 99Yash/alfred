import {
  HOST_CALL_OUTCOMES,
  type HostCallOutcome,
  type JsonValue,
  type ReadEvidenceRef,
  type ReadCoverage,
  type ToolName,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, inList } from "../helpers";
import { actionStagings } from "./action-policies";
import { agentRuns } from "./agent";
import { user } from "./auth";

/**
 * The evidence record of a `system.code_run` script (ADR-0124 amendment 2026-11-18): one row for
 * each host call. The parent's staging row holds the program source and the outcome, and a nested
 * staging row holds the read's input and result, so this row links to them and copies no content.
 * It adds what no other row holds: the order, the outcome of a call that wrote no row (a
 * `fast_path` read, a refusal), the evidence references, the content hash, and the coverage.
 *
 * Dispatch writes the record in the same transaction as the parent's guarded commit, and only when
 * that commit wins, so the record always belongs to the saved outcome, also after a failure. An
 * MCP read's `mcp_invocation` row is the one whose `staging_id` is `nested_staging_id`.
 */
export const codeRunHostCalls = pgTable(
  "code_run_host_calls",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("crhc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** The `system.code_run` call's staging row: the program source and the outcome. */
    parentStagingId: text("parent_staging_id")
      .notNull()
      .references(() => actionStagings.id, { onDelete: "cascade" }),
    /** `run`'s one-based request order within the script. */
    requestIndex: integer("request_index").notNull(),
    /** The guest path, for example `contacts.search` or `mcp.read`. */
    path: text("path").notNull(),
    /** The nested dispatch's tool. Null when the call did not reach dispatch (bad guest arguments). */
    toolName: text("tool_name").$type<ToolName>(),
    /** The nested call id, `<parent>#<hash>.<n>`. A nested staging row has it as `tool_call_id`. */
    callId: text("call_id"),
    /**
     * The parsed input, with the tool's secret redaction. Null when the input did not parse, so a
     * value that may hold a secret is not kept.
     */
    arguments: jsonb("arguments").$type<JsonValue>(),
    /** The nested call's staging row. Null for a `fast_path` read and a refusal before a row. */
    nestedStagingId: text("nested_staging_id").references(() => actionStagings.id, {
      onDelete: "cascade",
    }),
    outcome: text("outcome").$type<HostCallOutcome>().notNull(),
    /** The refusal text that the program got. Null when the read executed. */
    refusalMessage: text("refusal_message"),
    /** The reader's references, each with the hash of its item. Empty when no item was delivered. */
    evidence: jsonb("evidence").$type<ReadEvidenceRef[]>().notNull().default([]),
    /** References that the reader left out above its cap. */
    omittedEvidence: integer("omitted_evidence").notNull().default(0),
    /** `sha256Canonical` of the value that the program got. Null when the read did not deliver. */
    contentHash: text("content_hash"),
    /** Null when the reader states no coverage gap. */
    coverage: jsonb("coverage").$type<ReadCoverage>(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("code_run_host_calls_parent_request_idx").on(t.parentStagingId, t.requestIndex),
    index("code_run_host_calls_run_idx").on(t.runId),
    index("code_run_host_calls_nested_staging_idx").on(t.nestedStagingId),
    check(
      "code_run_host_calls_outcome_valid",
      sql`${t.outcome} IN (${inList(HOST_CALL_OUTCOMES)})`,
    ),
  ],
);

export type CodeRunHostCall = typeof codeRunHostCalls.$inferSelect;

export type NewCodeRunHostCall = typeof codeRunHostCalls.$inferInsert;
