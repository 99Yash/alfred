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
import { chatThreads } from "./chat";

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
    /**
     * The JSON bytes of the result that the nested staging row saved, so the storage of a script
     * is measured (ADR-0124 amendment 2026-11-18 (b)). Null when the read saved no result.
     */
    savedBytes: integer("saved_bytes"),
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

/**
 * A stored tool result that a later script reads with `system.load_result` (ADR-0087 points 1 and
 * 2, ADR-0130 decision 5). The JSON is in object storage at `storage_key`; this row is its
 * metadata. A chat turn on the script read path stores each script value, and each other result
 * whose model copy was cut. The next turn gets one transcript line for each live row of a message.
 *
 * The row is thread-scoped, and it expires 3 days after the fetch (owner, 2026-11-20). A daily job
 * deletes expired rows and their objects. A thread delete cascades the rows, and the thread's
 * storage prefix cleanup removes the objects.
 */
export const resultHandles = pgTable(
  "result_handles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rh")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The assistant message of the turn. The message row can come after this row, so no FK. */
    messageId: text("message_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** With `run_id`, the call that made the result. A replay of the call finds this row. */
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** The call input as compact JSON, cut to a short line for the transcript. */
    query: text("query").notNull(),
    /** The items of the largest list in the value. Null when the value has no list. */
    itemCount: integer("item_count"),
    /** The JSON bytes of the stored value. */
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("result_handles_run_call_idx").on(t.runId, t.toolCallId),
    index("result_handles_thread_message_idx").on(t.threadId, t.messageId),
    index("result_handles_expires_idx").on(t.expiresAt),
  ],
);

export type ResultHandle = typeof resultHandles.$inferSelect;

export type NewResultHandle = typeof resultHandles.$inferInsert;
