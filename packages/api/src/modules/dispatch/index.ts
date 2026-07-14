/**
 * Tool dispatcher (m13 Phase 3 / ADR-0034).
 *
 * Every tool call the boss (or a sub-agent) makes flows through
 * `dispatchToolCall`. Responsibilities:
 *
 *   1. Resolve the tool registry entry and validate the proposed input.
 *   2. Stable-hash the input (`hashToolInput`) for retry suppression and
 *      duplicate detection.
 *   3. Consult `user_action_policies` (in-process cache, bust via Redis
 *      Pub/Sub) to decide autonomy vs. gated.
 *   4. INSERT `action_stagings` row, idempotent on
 *      `(run_id, tool_call_id)`. The row is the canonical audit + UI
 *      surface for every tool call regardless of mode.
 *   5. Autonomy: execute the tool, update the row with the result, hand
 *      the result back to the caller.
 *   6. Gated: return a `staged` outcome carrying a `WakeCondition`
 *      whose `approvalId` is the staging row id. The agent loop turns
 *      that into a `StepResult.interrupt` so the executor parks the
 *      run; the resume path (the same step re-runs after approval) hits
 *      this function again with the same `tool_call_id` and finds an
 *      `approved` (or `rejected` / `expired`) row to act on.
 *
 * The dispatcher is also the retry-suppression gate (Phase 3c). When a
 * model re-proposes a tool call with byte-identical input to one the
 * user already rejected, we synthesize `rejected_by_user` immediately —
 * no second staging row, no second email — and the boss learns by
 * receiving the result.
 *
 * The function is single-pass: it handles both the initial dispatch and
 * the post-approval resume by branching on the existing row's status.
 * Callers don't need a separate "resume" entry point.
 */

import type { IntegrationSlug, PolicyMode, ToolName, ToolRiskTier } from "@alfred/contracts";
import {
  APPROVAL_EXPIRY_MS,
  getPath,
  hashToolInput,
  INTEGRATION_ACTIONS,
  integrationFromToolName,
  isIntegrationSlug,
  isRecord,
  isToolName,
  sanitizeErrorMessage,
  sanitizeToolResult,
  summarizeBody,
  toMessage,
} from "@alfred/contracts";
import {
  recordDispatchRejection,
  startToolSpan,
  type DispatchRejectionInput,
  type DispatchRejectionOutcome,
  type ToolSpanCloser,
  type ToolSpanInput,
} from "@alfred/ai";
import { db } from "@alfred/db";
import { actionStagings, type ActionStaging } from "@alfred/db/schemas";
import { actionStagingStatusSchema } from "@alfred/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  APP_ERROR_REGISTRY,
  isAppErrorCode,
  toPublicAppError,
  type PublicAppError,
} from "../../lib/app-errors";
import { logger, safeErrorDiagnostic } from "../../lib/logger";
import { enrichInvalidInputMessage } from "./invalid-input";
import { normalizeToolInputKeys } from "./normalize-keys";
import { emitReplicachePokes } from "../../events/replicache-events";
import { resolveApprovalNotifyDelayMs, resolvePolicyMode } from "../action-policies/resolve";
import type { WakeCondition } from "../agent/types";
import { readChildRunOutcome, shouldResolveWithoutParking } from "../agent/sub-agents";
import { subAgentDoneSignalName } from "../agent/sub-agent-metadata";
import {
  AWAIT_SUB_AGENT_CEILING_MS,
  scheduleSubAgentJoinWakeJob,
} from "../agent/sub-agent-join-wake-queue";
import { scheduleApprovalExpiryJob } from "../approvals/expiry-queue";
import { scheduleApprovalNotificationJob } from "../approvals/notification-queue";
import { parseScratchToolKey, type ScratchToolKey } from "../tools/scratch-key";
import { getTool, type RegisteredTool, type ToolExecuteContext } from "../tools/registry";
import { resolveUserTimezone } from "../user-timezone";

export interface DispatchArgs {
  runId: string;
  /** Logical executor step that owns this call — audit only. */
  stepId: string;
  /** Stable id from the model's tool call (deduplicates same call across step re-attempts). */
  toolCallId: string;
  toolName: string;
  input: unknown;
  userId: string;
  /** Who is calling — boss or named sub-agent. Threaded into the tool context. */
  caller?: ToolExecuteContext["caller"];
  /**
   * Chat thread + assistant message that owns this call, when dispatched from a
   * chat turn. Threaded into the tool context so artifact tools (ADR-0075) can
   * attribute the artifact to its thread/message. Omitted for background runs.
   */
  threadId?: string;
  messageId?: string;
  /** Scratchpad namespace to use for system scratch tools. Defaults to `runId`. */
  scratchpadRunId?: string;
  /**
   * The user's IANA timezone, if the caller already has it (e.g. chat snapshots
   * it once per run). Omitted → the dispatcher reads the `"timezone"` pref.
   */
  timezone?: string;
  /** Exact run-local capability surface. Registry membership alone is not executable. */
  activeTools: readonly ToolName[];
  /** Workflow integration cap, used by system tools such as `system.load_integration`. */
  allowedIntegrations?: readonly string[];
}

interface RejectedToolResult {
  status: "rejected_by_user";
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
  /** Hint to the boss: same input verbatim will be auto-rejected again. */
  retryPolicy: "do_not_retry_identical";
}

interface InvalidInputToolResult {
  status: "invalid_input";
  toolName: ToolName;
  message: string;
  issues?: unknown;
}

interface UnknownToolResult {
  status: "unknown_tool";
  toolName: string;
  message: string;
}

interface InactiveToolResult {
  status: "inactive_tool";
  toolName: ToolName;
  message: string;
  recovery: { kind: "activate_and_reissue"; toolName: ToolName };
}

interface NotAllowedToolResult {
  status: "not_allowed";
  toolName: ToolName;
  integration: IntegrationSlug;
  message: string;
}

export type DispatchResult =
  | {
      kind: "executed";
      stagingId: string | null;
      toolResult: unknown;
      /** True when the user edited the input before approving — the boss
       *  may want to surface that to the model so future suggestions
       *  account for the correction. */
      editedByUser: boolean;
      /** ADR-0070: set when the result carried persistence-poison (NUL /
       *  lone surrogates) that the dispatch-boundary sanitizer stripped. The
       *  flag rides on the envelope, never on the result value (a bare
       *  string/array result can't carry a property). */
      sanitized?: boolean;
    }
  | {
      kind: "failed";
      stagingId: string | null;
      error: PublicAppError;
    }
  | {
      kind: "rejected";
      /** `null` only on retry-suppression — no new row written. */
      stagingId: string | null;
      result: RejectedToolResult;
    }
  | {
      kind: "staged";
      stagingId: string;
      wake: Extract<WakeCondition, { kind: "hil" }>;
    }
  | {
      // ADR-0073: `system.await_sub_agent` on a still-running child. Carries a
      // `signal` wake the parent parks on; the child fires it on terminal
      // commit. Symmetric to `staged` — the agent loop turns it into a
      // `StepResult.interrupt`, and the whole batch re-dispatches on resume.
      kind: "parked";
      wake: Extract<WakeCondition, { kind: "signal" }>;
    }
  | {
      kind: "invalid_input";
      result: InvalidInputToolResult;
    }
  | {
      kind: "unknown_tool";
      result: UnknownToolResult;
    }
  | {
      kind: "inactive_tool";
      result: InactiveToolResult;
    }
  | {
      kind: "not_allowed";
      result: NotAllowedToolResult;
    };

type StagingRow = Pick<
  ActionStaging,
  | "id"
  | "runId"
  | "status"
  | "requiresApproval"
  | "toolName"
  | "proposedInput"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeSanitized"
  | "executeError"
  | "notifyAfterAt"
  | "notifiedAt"
  | "expiresAt"
>;

const STAGING_COLUMNS = {
  id: actionStagings.id,
  runId: actionStagings.runId,
  status: actionStagings.status,
  requiresApproval: actionStagings.requiresApproval,
  toolName: actionStagings.toolName,
  proposedInput: actionStagings.proposedInput,
  decidedInput: actionStagings.decidedInput,
  rejectReason: actionStagings.rejectReason,
  executeResult: actionStagings.executeResult,
  executeSanitized: actionStagings.executeSanitized,
  executeError: actionStagings.executeError,
  notifyAfterAt: actionStagings.notifyAfterAt,
  notifiedAt: actionStagings.notifiedAt,
  expiresAt: actionStagings.expiresAt,
} as const;

function parseStagingRow(row: StagingRow): StagingRow {
  return { ...row, status: actionStagingStatusSchema.parse(row.status) };
}

const UNKNOWN_TOOL_TRACE_NAME = "<unknown>";
const TOOLISH_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;
let dispatchRejectionRecorder: (args: DispatchRejectionInput) => void = recordDispatchRejection;
let toolSpanStarter: (args: ToolSpanInput) => ToolSpanCloser = startToolSpan;

/** Zod-issue shape we read for the rejection signature (loose by design). */
type RejectionIssue = { code?: string; path?: readonly PropertyKey[] };

/**
 * Caller label for trace metadata: `boss` or `sub:<id>`. Mirrors the
 * `executeToolWithSpan` derivation so reject spans and execute spans label the
 * same caller identically.
 */
function callerLabel(caller: DispatchArgs["caller"]): string {
  if (caller === undefined || caller === "boss") return "boss";
  return `sub:${caller.subId}`;
}

/**
 * PII-free fingerprint of a dispatch rejection (#345). For a Zod miss it folds
 * in each issue's `code@path` so the boss re-proposing the same broken input
 * yields the same signature — the "bounce on the same wall" pattern becomes a
 * single countable bucket in the Traces view. Issue order is normalized so the
 * signature is stable regardless of Zod's emission order.
 */
function rejectionSignature(
  toolName: string,
  outcome: DispatchRejectionOutcome,
  issues?: readonly RejectionIssue[],
  candidateToolName?: string,
): string {
  const base =
    candidateToolName === undefined
      ? `${toolName}:${outcome}`
      : `${toolName}:${candidateToolName}:${outcome}`;
  if (!issues || issues.length === 0) return base;
  const parts = issues
    .map((issue) => `${issue.code ?? "?"}@${(issue.path ?? []).map(pathPart).join(".")}`)
    .sort();
  return `${base}:${parts.join(",")}`;
}

function pathPart(part: PropertyKey): string {
  if (typeof part === "symbol") return "symbol";
  return String(part);
}

function safeUnknownToolCandidate(toolName: string): string | undefined {
  const trimmed = toolName.trim();
  if (trimmed.length === 0 || trimmed.length > 120 || !TOOLISH_NAME.test(trimmed)) return undefined;
  return summarizeBody(sanitizeErrorMessage(trimmed), 120);
}

function redactTraceInput(tool: RegisteredTool, input: unknown): unknown | undefined {
  if (!tool.redactInput) return input;
  try {
    return tool.redactInput(input);
  } catch (err) {
    console.warn("[dispatch] tool input redaction failed:", toMessage(err));
    return undefined;
  }
}

export function _setDispatchTraceSinksForTests(sinks: {
  rejectionRecorder?: (args: DispatchRejectionInput) => void;
  toolSpanStarter?: (args: ToolSpanInput) => ToolSpanCloser;
}): () => void {
  const previousRejectionRecorder = dispatchRejectionRecorder;
  const previousToolSpanStarter = toolSpanStarter;
  if (sinks.rejectionRecorder) dispatchRejectionRecorder = sinks.rejectionRecorder;
  if (sinks.toolSpanStarter) toolSpanStarter = sinks.toolSpanStarter;
  return () => {
    dispatchRejectionRecorder = previousRejectionRecorder;
    toolSpanStarter = previousToolSpanStarter;
  };
}

export function buildDispatchRejectionTraceInput(args: {
  dispatch: DispatchArgs;
  outcome: DispatchRejectionOutcome;
  reason: string;
  issues?: readonly RejectionIssue[];
  /** Safe grouping identity. Raw undeclared names must use `<unknown>`. */
  toolName?: string;
  /** Optional sanitized + bounded model-supplied name hint for unknown tools. */
  candidateToolName?: string;
  /** Actual payload rejected by this branch. Callers must pass only payloads safe for trace I/O. */
  input?: unknown;
  /** Present only when `input` is already schema-valid for this tool. */
  tool?: RegisteredTool;
  startedAt?: Date;
}): DispatchRejectionInput {
  const toolName = args.toolName ?? args.dispatch.toolName;
  const input = args.tool ? redactTraceInput(args.tool, args.input) : undefined;
  return {
    runId: args.dispatch.runId,
    toolName,
    candidateToolName: args.candidateToolName,
    toolCallId: args.dispatch.toolCallId,
    userId: args.dispatch.userId,
    caller: callerLabel(args.dispatch.caller),
    stepId: args.dispatch.stepId,
    outcome: args.outcome,
    reason: args.reason,
    signature: rejectionSignature(toolName, args.outcome, args.issues, args.candidateToolName),
    detail: args.issues,
    input,
    startedAt: args.startedAt ?? new Date(),
  };
}

/**
 * Emit a trace node for a dispatch attempt that short-circuited before execute
 * (#345). Pulls the common identity off `DispatchArgs` so each early-return
 * branch is a one-liner. Fire-and-forget — `recordDispatchRejection` swallows
 * everything, so this can never affect the dispatch result.
 */
function recordRejection(args: {
  dispatch: DispatchArgs;
  outcome: DispatchRejectionOutcome;
  reason: string;
  issues?: readonly RejectionIssue[];
  toolName?: string;
  candidateToolName?: string;
  input?: unknown;
  tool?: RegisteredTool;
}): void {
  dispatchRejectionRecorder(buildDispatchRejectionTraceInput(args));
}

export async function dispatchToolCall(args: DispatchArgs): Promise<DispatchResult> {
  if (!isToolName(args.toolName)) {
    const message = undeclaredToolMessage(args.toolName, args.allowedIntegrations);
    recordRejection({
      dispatch: args,
      toolName: UNKNOWN_TOOL_TRACE_NAME,
      candidateToolName: safeUnknownToolCandidate(args.toolName),
      outcome: "unknown_tool",
      reason: "Tool is not declared",
    });
    return {
      kind: "unknown_tool",
      result: {
        status: "unknown_tool",
        toolName: args.toolName,
        message,
      },
    };
  }

  const toolName = args.toolName;
  const tool = getTool(toolName);
  if (!tool) {
    const message = `Tool '${toolName}' is not registered`;
    recordRejection({ dispatch: args, outcome: "unknown_tool", reason: message, toolName });
    return {
      kind: "unknown_tool",
      result: {
        status: "unknown_tool",
        toolName,
        message,
      },
    };
  }

  const integration = integrationFromToolName(toolName);
  if (
    integration !== "system" &&
    args.allowedIntegrations?.length &&
    !args.allowedIntegrations.includes(integration)
  ) {
    const message = `Tool '${toolName}' is not allowed by this workflow`;
    recordRejection({ dispatch: args, outcome: "not_allowed", reason: message, toolName });
    return {
      kind: "not_allowed",
      result: { status: "not_allowed", toolName, integration, message },
    };
  }

  if (!args.activeTools.includes(toolName)) {
    const message =
      `Tool '${toolName}' was inactive. Its exact schema will be available on the next turn; ` +
      "issue a fresh call using that schema.";
    recordRejection({ dispatch: args, outcome: "inactive_tool", reason: message, toolName });
    return {
      kind: "inactive_tool",
      result: {
        status: "inactive_tool",
        toolName,
        message,
        recovery: { kind: "activate_and_reissue", toolName },
      },
    };
  }

  // Normalize casing/underscore variants of real param names to the schema key
  // before validation (param-ergonomics pass) — kills the dominant
  // `unrecognized_keys` failure family (`max_results`→`maxResults`, snake↔camel)
  // across every tool with one mechanism. Synonyms and the query DSL are still
  // handled by the schema's own preprocess wrappers, which run inside safeParse.
  const normalized = normalizeToolInputKeys(args.input, tool.inputSchema);
  const parsed = tool.inputSchema.safeParse(normalized.input);
  if (!parsed.success) {
    const message = enrichInvalidInputMessage(
      parsed.error.message,
      tool.inputSchema,
      parsed.error.issues,
    );
    recordRejection({
      dispatch: args,
      outcome: "invalid_input",
      reason: message,
      issues: parsed.error.issues,
      toolName,
    });
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message,
        issues: parsed.error.issues,
      },
    };
  }
  const input = parsed.data as unknown;
  const caller = args.caller ?? "boss";
  const ctx: ToolExecuteContext = {
    runId: args.runId,
    scratchpadRunId: args.scratchpadRunId ?? args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    userId: args.userId,
    timezone: args.timezone ?? (await resolveUserTimezone(args.userId)),
    caller,
    threadId: args.threadId,
    messageId: args.messageId,
    allowedIntegrations: args.allowedIntegrations,
  };
  const scratchAccessError = validateScratchToolAccess({ toolName, input, caller });
  if (scratchAccessError) {
    recordRejection({
      dispatch: args,
      outcome: "invalid_input",
      reason: scratchAccessError,
      toolName,
      tool,
      input,
    });
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: scratchAccessError,
      },
    };
  }
  const systemAccessError = validateSystemToolAccess({ toolName, caller });
  if (systemAccessError) {
    recordRejection({
      dispatch: args,
      outcome: "invalid_input",
      reason: systemAccessError,
      toolName,
      tool,
      input,
    });
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: systemAccessError,
      },
    };
  }

  // ADR-0073: the join. Intercept before the staging/execute path so we can
  // *park* the parent on the child's completion signal instead of returning a
  // result the boss would have to poll. A terminal (or timed-out) child returns
  // its real outcome inline; a still-running child parks the step.
  if (toolName === "system.await_sub_agent") {
    return await resolveAwaitSubAgentWithSpan(tool, input, ctx);
  }

  if (isScratchFastPathTool(toolName)) {
    return executeFastPath(tool, input, ctx);
  }

  const proposedInputHash = hashToolInput(toolName, input);

  // Retry suppression — Phase 3c. A prior `rejected` row for this run +
  // tool + input hash means the user has already said no to this exact
  // proposal; synthesize the same rejection without writing a new row
  // or firing a new notification. Limited to the same run because
  // ADR-0034 scopes the partial index that way.
  const priorReject = await db()
    .select({
      reason: actionStagings.rejectReason,
      decidedAt: actionStagings.decidedAt,
    })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, args.runId),
        eq(actionStagings.toolName, toolName),
        eq(actionStagings.proposedInputHash, proposedInputHash),
        eq(actionStagings.status, "rejected"),
      ),
    )
    .orderBy(desc(actionStagings.decidedAt))
    .limit(1);

  if (priorReject[0]) {
    const reason = priorReject[0].reason ?? "rejected by user";
    // Retry-suppression: the boss re-proposed byte-identical input the user
    // already rejected. This is exactly the "bounce on the same wall" pattern
    // #345 wants countable — the shared signature buckets every repeat.
    recordRejection({ dispatch: args, outcome: "rejected", reason, toolName, tool, input });
    return {
      kind: "rejected",
      stagingId: null,
      result: synthesizeRejection({
        toolName,
        proposedInput: input,
        reason,
      }),
    };
  }

  const riskTier: ToolRiskTier = tool.riskTier;
  const policyMode =
    integration === "system" ? "autonomy" : await resolvePolicyMode(args.userId, toolName);
  const requiresApproval = toolRequiresApproval(policyMode, riskTier);
  const approvalNotifyDelayMs = requiresApproval
    ? await resolveApprovalNotifyDelayMs(args.userId)
    : null;
  const notifyAfterAt =
    approvalNotifyDelayMs !== null ? new Date(Date.now() + approvalNotifyDelayMs) : null;
  // Gated rows get a hard expiry so an undecided approval can't park the
  // run forever (Phase 5e). The `staging-expire` worker fires at this
  // time and auto-rejects if still pending.
  const expiresAt = requiresApproval ? new Date(Date.now() + APPROVAL_EXPIRY_MS) : null;

  // Single upsert. On a `(run_id, tool_call_id)` conflict we do a *no-op*
  // UPDATE purely so the existing row is RETURNED — `onConflictDoNothing`
  // returns nothing on conflict, which previously forced a second SELECT-back
  // round-trip. The no-op set MUST NOT touch any decision/result column: a
  // re-dispatch of an already-staged/approved/executed call has to read the
  // stored row verbatim (the resume path below depends on it). `xmax = 0`
  // distinguishes a freshly-inserted row from an updated (conflict) one — the
  // standard Postgres upsert idiom — so the Replicache poke stays gated to
  // genuinely-new rows.
  // #293: redact secrets from the persisted `proposed_input` — but ONLY for an
  // autonomous call. A gated tool's `proposed_input` doubles as the
  // approval-resume payload (the `approved` branch below re-executes from it when
  // the user didn't edit), so redacting it would corrupt resume. fetch_url is
  // autonomous, so it always takes the redacted branch; the guard is the seam for
  // a future gated secret-bearing tool. The hash + execute always use raw `input`.
  const proposedInputForRow =
    !requiresApproval && tool.redactInput ? tool.redactInput(input) : input;
  const upserted = await db()
    .insert(actionStagings)
    .values({
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      toolCallId: args.toolCallId,
      toolName,
      integration,
      riskTier,
      proposedInput: proposedInputForRow as object,
      proposedInputHash,
      requiresApproval,
      status: "pending",
      notifyAfterAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [actionStagings.runId, actionStagings.toolCallId],
      set: { rowVersion: sql`${actionStagings.rowVersion}` },
    })
    .returning({ ...STAGING_COLUMNS, wasInserted: sql<boolean>`xmax = 0` });

  const upsertedRow = upserted[0];
  if (!upsertedRow) {
    throw new Error(
      `[dispatch] action_stagings upsert returned no row (run=${args.runId}, toolCallId=${args.toolCallId})`,
    );
  }
  const { wasInserted, ...rowColumns } = upsertedRow;
  const insertedNew = wasInserted;
  const row: StagingRow = parseStagingRow(rowColumns);
  // Defensive: the (run_id, tool_call_id) unique index says one tool call id
  // maps to one row. If a caller re-dispatches the same id with a different
  // `toolName`, the model emitted two tools under the same call id — a
  // programming/model bug, not a dispatcher policy decision. Fail loud rather
  // than silently executing the new tool while updating the original row's
  // audit trail. (No-op on a fresh insert: the stored toolName equals the
  // dispatched one.)
  if (row.toolName !== toolName) {
    throw new Error(
      `[dispatch] toolName mismatch on re-dispatch (run=${args.runId}, toolCallId=${args.toolCallId}, stored='${row.toolName}', got='${toolName}')`,
    );
  }
  switch (row.status) {
    case "pending":
      // Honor the `requires_approval` recorded on the row, NOT the
      // freshly-resolved policy. If the user changed their integration
      // mode after the row was inserted (e.g. gated → autonomy), the
      // pending row should still respect the decision that was active
      // when it was staged — otherwise a policy toggle would silently
      // auto-execute every in-flight gated call. Policy changes apply
      // to the next dispatched tool call; once staged, a row's gate
      // sticks. Mirrors the plan's intent that `requires_approval` is
      // the locked-in decision per ADR-0034.
      if (row.requiresApproval) {
        // Park. The executor emits the transient `approval.requested`
        // event when it commits the interrupt; Replicache carries the
        // durable approvals queue. Emit the poke only for a newly-created
        // row so crash/resume re-dispatches don't spam connected clients.
        if (insertedNew) emitReplicachePokes([args.userId], row.id);
        if (!row.notifiedAt) {
          const delayMs =
            row.notifyAfterAt instanceof Date
              ? row.notifyAfterAt.getTime() - Date.now()
              : (approvalNotifyDelayMs ?? 0);
          await scheduleApprovalNotificationJob({
            stagingId: row.id,
            userId: args.userId,
            delayMs,
          });
        }
        // Schedule the hard-expiry fallback. Idempotent on the
        // deterministic job id, so a crash/resume re-dispatch of the same
        // staged call won't double-schedule. Delay derives from the
        // row's stored `expires_at` so the timer survives restarts.
        {
          const expiryDelayMs =
            row.expiresAt instanceof Date
              ? row.expiresAt.getTime() - Date.now()
              : APPROVAL_EXPIRY_MS;
          await scheduleApprovalExpiryJob({
            stagingId: row.id,
            userId: args.userId,
            delayMs: expiryDelayMs,
          });
        }
        return {
          kind: "staged",
          stagingId: row.id,
          wake: {
            kind: "hil",
            approvalId: row.id,
            approvalKind: "action_staging",
            prompt: `Approve ${toolName}`,
          },
        };
      }
      return executeAndCommit(row, tool, input, ctx, /* editedByUser */ false);

    case "approved": {
      // Resume after user approval — execute with the decided input if
      // they edited it, otherwise with the originally-proposed input
      // STORED on the row. Never use `args.input` here: the user
      // approved the row's `proposed_input`, not whatever the caller
      // re-supplied on this dispatch. A caller that re-dispatches with
      // a mutated payload should not be able to slip an unapproved
      // input past the gate via the resume path.
      const editedByUser = row.decidedInput !== null && row.decidedInput !== undefined;
      const useInput = editedByUser ? row.decidedInput : row.proposedInput;
      // Re-validate so an edited payload that violates the schema
      // becomes a failed row rather than a thrown executor. The
      // originally-proposed input was already validated on insert; the
      // decided input came from the user via the approval API and may
      // not have been validated there.
      const reparsed = tool.inputSchema.safeParse(useInput);
      if (!reparsed.success) {
        const now = new Date();
        const error = toPublicAppError(undefined, "tool_input_invalid");
        await db()
          .update(actionStagings)
          .set({
            status: "failed",
            executeError: error,
            executedAt: now,
            rowVersion: sql`${actionStagings.rowVersion} + 1`,
          })
          .where(eq(actionStagings.id, row.id));
        if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
        // A post-approval reparse failure never reaches `executeToolWithSpan`
        // (no execution happened), so without this it would be a `failed` row
        // with no trace node (#345) — e.g. a user-edited approval payload that
        // violates the schema.
        recordRejection({
          dispatch: args,
          outcome: "failed",
          reason: error.message,
          issues: reparsed.error.issues,
          toolName,
        });
        return {
          kind: "failed",
          stagingId: row.id,
          error,
        };
      }
      return executeAndCommit(row, tool, reparsed.data as unknown, ctx, editedByUser);
    }

    case "rejected": {
      const reason = row.rejectReason ?? "rejected by user";
      recordRejection({
        dispatch: args,
        outcome: "rejected",
        reason,
        toolName,
        tool,
        input: row.proposedInput,
      });
      return {
        kind: "rejected",
        stagingId: row.id,
        result: synthesizeRejection({
          toolName,
          proposedInput: row.proposedInput,
          reason,
        }),
      };
    }

    case "expired":
      recordRejection({
        dispatch: args,
        outcome: "rejected",
        reason: "auto-expired",
        toolName,
        tool,
        input: row.proposedInput,
      });
      return {
        kind: "rejected",
        stagingId: row.id,
        result: synthesizeRejection({
          toolName,
          proposedInput: row.proposedInput,
          reason: "auto-expired",
        }),
      };

    case "executed":
      // Idempotent re-dispatch. The model proposed the same tool call
      // again (step re-attempt) and the row already carries the
      // result — hand it straight back without re-executing. Carry the
      // persisted sanitize verdict so the "may be incomplete" notice survives
      // the replay (ADR-0070 §1.1); a stripped result must never read as
      // pristine on a second look.
      return {
        kind: "executed",
        stagingId: row.id,
        toolResult: row.executeResult,
        editedByUser: row.decidedInput !== null && row.decidedInput !== undefined,
        sanitized: row.executeSanitized,
      };

    case "failed":
      return {
        kind: "failed",
        stagingId: row.id,
        error: extractStoredError(row.executeError),
      };

    default: {
      // Unknown statuses surface as a failure rather than throwing —
      // the agent loop turns them into a tool result the boss can
      // reason about.
      const diagnostic = `dispatcher saw unexpected staging status '${row.status}'`;
      const error = toPublicAppError(undefined);
      recordRejection({
        dispatch: args,
        outcome: "failed",
        reason: diagnostic,
        toolName,
        tool,
        input: row.proposedInput,
      });
      return {
        kind: "failed",
        stagingId: row.id,
        error,
      };
    }
  }
}

/**
 * Whether a tool call must be staged for human approval. Two independent
 * triggers, OR'd:
 *
 *   1. The user's policy resolves to `gated` (tool override → integration mode
 *      → user default, per ADR-0034).
 *   2. A risk-tier floor: a `high`-tier tool ALWAYS confirms, regardless of
 *      policy. The global "Auto" autonomy toggle is a chat-convenience control
 *      (stop nagging me about reads); it must not silently authorize the
 *      handful of genuinely-irreversible actions (send a real email, redeploy a
 *      service — including a shared team workspace). riskTier was previously a
 *      display-only hint (registry.ts header); this makes `high` load-bearing
 *      for the gate. Amends ADR-0034 — see decisions.md.
 *
 * Keep this the single definition of the gate so the live dispatch path and the
 * `toolCallWouldGate` scheduling hint can never drift apart.
 */
export function toolRequiresApproval(policyMode: PolicyMode, riskTier: ToolRiskTier): boolean {
  return policyMode === "gated" || riskTier === "high";
}

/**
 * Best-effort prediction of whether a *fresh* dispatch of this tool would gate
 * (stage for approval) instead of executing autonomously. Mirrors the policy +
 * risk-tier gate in {@link dispatchToolCall}: `system.*` is always autonomy,
 * everything else follows the user's (cached) policy mode OR the high-tier
 * floor.
 *
 * This is a scheduling hint, not a correctness gate — `dispatchToolCall` stays
 * the source of truth and still honors the row's stored `requires_approval` on
 * resume. Batch callers use it to avoid staging more than one gated write at
 * once: gated writes only *stage* during dispatch (the real work runs after
 * approval), so parallelizing them buys no latency while breaking the HIL
 * contract (the run parks on a single `approvalId`; sibling approval cards 409
 * on `wake_mismatch` and each fires its own email).
 */
export async function toolCallWouldGate(userId: string, toolName: string): Promise<boolean> {
  if (!isToolName(toolName)) return false;
  if (integrationFromToolName(toolName) === "system") return false;
  const policyMode = await resolvePolicyMode(userId, toolName);
  const riskTier = getTool(toolName)?.riskTier ?? "no_risk";
  return toolRequiresApproval(policyMode, riskTier);
}

export function undeclaredToolMessage(
  toolName: string,
  allowedIntegrations: readonly string[] = [],
): string {
  const suggestion = integrationActionSuggestion(toolName, allowedIntegrations);
  if (!suggestion) return `Tool '${toolName}' is not declared`;

  const validActions =
    suggestion.validActions.length > 0
      ? `${suggestion.integration} exposes: ${suggestion.validActions.map((action) => `\`${action}\``).join(", ")}.`
      : `${suggestion.integration} exposes no callable actions yet.`;
  const retry =
    suggestion.toolName === null
      ? null
      : suggestion.inputWasQualified
        ? `Use '${suggestion.toolName}' instead.`
        : `Integration tools use qualified names like '${suggestion.toolName}'.`;
  const loadHint =
    suggestion.toolName === null
      ? `Call system.load_integration with slug '${suggestion.integration}' first.`
      : `Call system.load_integration with slug '${suggestion.integration}' first if that integration is not active,`;
  return [
    `Tool '${toolName}' is not declared.`,
    validActions,
    retry,
    loadHint,
    suggestion.toolName === null ? null : `then retry '${suggestion.toolName}'.`,
    "Do not ask the user just to load an integration.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function integrationActionSuggestion(
  input: string,
  allowedIntegrations: readonly string[],
): {
  integration: IntegrationSlug;
  toolName: ToolName | null;
  validActions: readonly string[];
  inputWasQualified: boolean;
} | null {
  const qualified = parseQualifiedToolName(input);
  if (qualified) {
    const { integration, action } = qualified;
    if (integration === "system") return null;
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(integration)) {
      return null;
    }
    const actions: readonly string[] = INTEGRATION_ACTIONS[integration];
    const closest = closestAction(action, actions);
    const toolName = closest ? toolNameForAction(integration, closest) : null;
    return { integration, toolName, validActions: actions, inputWasQualified: true };
  }

  // A bare integration slug (`calendar`) — the boss mistook the integration for
  // a single tool and called it with an `action` arg. We can't recover the
  // intended action from the tool name alone (it lived in the rejected args),
  // so enumerate the integration's tools and point at load_integration; the
  // model picks the right `integration.action` on retry.
  if (isIntegrationSlug(input) && input !== "system") {
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(input)) {
      return null;
    }
    // No tools to point at — recovering would loop the boss through a
    // load_integration that yields nothing callable (#286 review).
    if (INTEGRATION_ACTIONS[input].length === 0) return null;
    return {
      integration: input,
      toolName: null,
      validActions: INTEGRATION_ACTIONS[input],
      inputWasQualified: false,
    };
  }

  const matches = (Object.keys(INTEGRATION_ACTIONS) as IntegrationSlug[]).filter((integration) => {
    if (integration === "system") return false;
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(integration)) {
      return false;
    }
    const actions: readonly string[] = INTEGRATION_ACTIONS[integration];
    return actions.includes(input);
  });
  if (matches.length !== 1) return null;

  const integration = matches[0];
  if (!integration) return null;
  const toolName = toolNameForAction(integration, input);
  if (!toolName) return null;
  return {
    integration,
    toolName,
    validActions: INTEGRATION_ACTIONS[integration],
    inputWasQualified: false,
  };
}

function parseQualifiedToolName(
  toolName: string,
): { integration: IntegrationSlug; action: string } | null {
  const separator = toolName.indexOf(".");
  if (separator <= 0 || separator !== toolName.lastIndexOf(".")) return null;
  const integration = toolName.slice(0, separator);
  if (!isIntegrationSlug(integration)) return null;
  const action = toolName.slice(separator + 1);
  if (!action) return null;
  return { integration, action };
}

function toolNameForAction(integration: IntegrationSlug, action: string): ToolName | null {
  const name = `${integration}.${action}`;
  return isToolName(name) ? name : null;
}

/**
 * Action-name tokens that signal an *enumeration* intent — an invented
 * `list_*`/`find_*`/`search_*`/`all_*` tool is asking to list many items, which
 * a single-item `get_<thing>` (needs a known id) can never satisfy. Plain token
 * overlap routes `list_pull_requests` → `get_pull_request` (shared "pull"),
 * which is exactly the wrong hint; an integration's `search` action is the one
 * that can actually enumerate.
 */
const ENUMERATION_TOKENS = new Set(["list", "find", "all", "search"]);

function closestAction(input: string, actions: readonly string[]): string | null {
  if (actions.length === 0) return null;
  if (actions.includes(input)) return input;
  if (actions.length === 1) return actions[0] ?? null;

  const inputTokens = actionTokens(input);
  // Enumeration intent → `search` when the integration exposes one, before the
  // generic overlap below can mis-route it to a single-item `get_*`.
  if (actions.includes("search") && inputTokens.some((t) => ENUMERATION_TOKENS.has(t))) {
    return "search";
  }
  let best: { action: string; score: number } | null = null;
  for (const action of actions) {
    const actionTokenSet = new Set(actionTokens(action));
    const common = inputTokens.filter((token) => actionTokenSet.has(token)).length;
    const substring = action.includes(input) || input.includes(action) ? 1 : 0;
    const score = common * 10 + substring * 5 - Math.abs(action.length - input.length) / 10;
    if (!best || score > best.score) best = { action, score };
  }

  return best && best.score > 0 ? best.action : null;
}

function actionTokens(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Run a tool inside a Langfuse span nested under the run trace (#214). Both
 * execution paths (staged + scratch fast-path) funnel through here so every
 * actual execution lands as a `tool:<name>` span in the run tree. The span
 * records timing and metadata always; I/O rides the `LANGFUSE_CAPTURE_IO` gate.
 * Errors close the span and rethrow so each caller keeps its own poison-aware
 * error handling.
 *
 * The pre-execution short-circuits (unknown/invalid/rejected/reparse-failed) no
 * longer go dark: #345 reversed the execution-only policy — they emit their own
 * zero-duration `tool:<name>` node via `recordDispatchRejection`, tagged with
 * the dispatch `outcome` and a countable `rejectionSignature`. A `staged`/parked
 * call still gets its span later, when the approved/resumed step executes.
 */
async function executeToolWithSpan(
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<unknown> {
  const span = toolSpanStarter({
    runId: ctx.runId,
    toolName: tool.name,
    toolCallId: ctx.toolCallId,
    userId: ctx.userId,
    caller: ctx.caller === "boss" ? "boss" : `sub:${ctx.caller.subId}`,
    stepId: ctx.stepId,
    // #293: the trace/span sink ALWAYS gets the redacted input — unlike
    // `proposed_input`, a span is never a resume payload, so there's no gated
    // exception. `execute` below still receives the raw `input`.
    input: tool.redactInput ? tool.redactInput(input) : input,
    startedAt: new Date(),
  });
  try {
    const result = await tool.execute(input, ctx);
    span.success(result);
    return result;
  } catch (err) {
    // Strip NUL-byte poison before the span records the message (the span
    // itself also redacts secrets + bounds length — see `startToolSpan`).
    // Mirrors the `execute_error` DB-write sanitization below.
    span.error(safeErrorDiagnostic(err));
    throw err;
  }
}

async function resolveAwaitSubAgentWithSpan(
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<DispatchResult> {
  const span = toolSpanStarter({
    runId: ctx.runId,
    toolName: tool.name,
    toolCallId: ctx.toolCallId,
    userId: ctx.userId,
    caller: ctx.caller === "boss" ? "boss" : `sub:${ctx.caller.subId}`,
    stepId: ctx.stepId,
    input: tool.redactInput ? tool.redactInput(input) : input,
    startedAt: new Date(),
  });
  try {
    const result = await resolveAwaitSubAgent({
      parentRunId: ctx.runId,
      userId: ctx.userId,
      childRunId: (input as { childRunId: string }).childRunId,
    });
    span.success(awaitSubAgentSpanOutput(result));
    return result;
  } catch (err) {
    span.error(safeErrorDiagnostic(err));
    logger.error(
      { err, event: "await_sub_agent_failed", toolName: tool.name, runId: ctx.runId },
      "Awaiting the sub-agent failed",
    );
    throw err;
  }
}

function awaitSubAgentSpanOutput(result: DispatchResult): unknown {
  switch (result.kind) {
    case "executed":
      return result.toolResult;
    case "parked":
      return { status: "parked", wake: result.wake };
    case "failed":
      return { status: "failed", error: result.error };
    default:
      return { status: result.kind };
  }
}

async function executeAndCommit(
  row: StagingRow,
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
  editedByUser: boolean,
): Promise<DispatchResult> {
  let result: unknown;
  let error: PublicAppError | undefined;
  try {
    result = await executeToolWithSpan(tool, input, ctx);
  } catch (err) {
    // Throw-poison class (ADR-0070 §1.3): a tool that *throws* a NUL-byte
    // message. The result-boundary sanitizer below can't reach this — a throw
    // carries no result — so strip the error string before it hits the
    // `execute_error` jsonb write. Project through the closed public-error
    // registry so arbitrary exception text cannot reach persistence or users.
    error = toPublicAppError(err);
    logger.error(
      { err, event: "tool_execution_failed", toolName: tool.name, runId: ctx.runId },
      error.message,
    );
  }
  const now = new Date();
  if (error) {
    await db()
      .update(actionStagings)
      .set({
        status: "failed",
        executeError: error,
        executedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, row.id));
    if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
    return { kind: "failed", stagingId: row.id, error };
  }
  // ADR-0070 §1.1: sanitize at the dispatch boundary, the instant the tool
  // returns and before the value touches any persisted sink. This cleans the
  // `execute_result` jsonb write below AND the `toolResult` returned to the
  // caller (which flows into the transcript/state — the same poison sinks).
  const sanitizedResult = sanitizeToolResult(result);
  result = sanitizedResult.value;
  const didSanitize = sanitizedResult.removed > 0 || sanitizedResult.collisions > 0;
  if (didSanitize) {
    console.warn(
      `[dispatch] sanitized ${sanitizedResult.removed} poison code unit(s)` +
        `${sanitizedResult.collisions > 0 ? `, ${sanitizedResult.collisions} key collision(s)` : ""}` +
        ` from ${tool.name} result`,
    );
  }
  // A tool legitimately returning `null` or `undefined` is stored as
  // SQL NULL in `execute_result`. The `status='executed'` field is the
  // discriminator for "execution happened" — readers should never infer
  // "no result yet" from a null payload. The single-threaded-per-run
  // executor model (one worker holds the lease) is what guarantees no
  // other process can interleave a status flip between the
  // `tool.execute` above and this UPDATE; if that invariant ever
  // changes, add `AND status IN ('pending', 'approved')` here.
  await db()
    .update(actionStagings)
    .set({
      status: "executed",
      executeResult: (result === undefined ? null : result) as object | null,
      // Persist the sanitize verdict alongside the scrubbed result so the
      // idempotent `executed` replay (see dispatchStagedRow) can re-emit the
      // same "may be incomplete" notice rather than replaying it as pristine.
      executeSanitized: didSanitize,
      executedAt: now,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(eq(actionStagings.id, row.id));
  if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
  return {
    kind: "executed",
    stagingId: row.id,
    toolResult: result,
    editedByUser,
    sanitized: didSanitize,
  };
}

async function executeFastPath(
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<DispatchResult> {
  try {
    const result = await executeToolWithSpan(tool, input, ctx);
    // ADR-0070 §1.1: sanitize at the boundary even on the fast path — this
    // result flows into the transcript/state just like the staged path.
    const sanitized = sanitizeToolResult(result);
    const didSanitize = sanitized.removed > 0 || sanitized.collisions > 0;
    if (didSanitize) {
      console.warn(
        `[dispatch] sanitized ${sanitized.removed} poison code unit(s)` +
          `${sanitized.collisions > 0 ? `, ${sanitized.collisions} key collision(s)` : ""}` +
          ` from ${tool.name} result`,
      );
    }
    return {
      kind: "executed",
      stagingId: null,
      toolResult: sanitized.value,
      editedByUser: false,
      sanitized: didSanitize,
    };
  } catch (err) {
    // Throw-poison class (ADR-0070 §1.3). The public-error registry also keeps
    // arbitrary exception text out of the model and transport boundaries.
    const error = toPublicAppError(err);
    logger.error(
      { err, event: "tool_execution_failed", toolName: tool.name, runId: ctx.runId },
      error.message,
    );
    return {
      kind: "failed",
      stagingId: null,
      error,
    };
  }
}

interface SynthesizeRejectionArgs {
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
}

function synthesizeRejection(args: SynthesizeRejectionArgs): RejectedToolResult {
  return {
    status: "rejected_by_user",
    toolName: args.toolName,
    proposedInput: args.proposedInput,
    reason: args.reason,
    retryPolicy: "do_not_retry_identical",
  };
}

function extractStoredError(stored: unknown): PublicAppError {
  const code = isRecord(stored) ? stored.code : undefined;
  if (isAppErrorCode(code)) return { code, message: APP_ERROR_REGISTRY[code].message };
  // Legacy rows may contain raw exception text. Never replay it to the model.
  return toPublicAppError(undefined);
}

function validateScratchToolAccess(args: {
  toolName: ToolName;
  input: unknown;
  caller: ToolExecuteContext["caller"];
}): string | null {
  if (args.toolName === "system.read_scratch") {
    const key = readStringProp(args.input, "key");
    const target = parseScratchAccessKey(key);
    if (typeof target === "string") return target;
    if (args.caller !== "boss" && target.zone === "scratch" && target.subId !== args.caller.subId) {
      return `Sub-agent '${args.caller.subId}' cannot read scratch for '${target.subId}'`;
    }
    return null;
  }

  if (args.toolName === "system.write_scratch") {
    const key = readStringProp(args.input, "key");
    const target = parseScratchAccessKey(key);
    if (typeof target === "string") return target;
    if (args.caller === "boss") {
      return target.zone === "shared" ? null : "Boss can only write shared.<path> scratch keys";
    }
    return target.zone === "scratch" && target.subId === args.caller.subId
      ? null
      : `Sub-agent '${args.caller.subId}' can only write scratch.${args.caller.subId}.<path> keys`;
  }

  if (args.toolName === "system.promote") {
    if (args.caller !== "boss") return "system.promote can only be called by the boss";
    const from = parseScratchAccessKey(readStringProp(args.input, "fromKey"));
    if (typeof from === "string") return from;
    const to = parseScratchAccessKey(readStringProp(args.input, "toKey"));
    if (typeof to === "string") return to;
    if (from.zone !== "scratch") return "system.promote fromKey must be scratch.<subId>.<path>";
    if (to.zone !== "shared") return "system.promote toKey must be shared.<path>";
    return null;
  }

  return null;
}

function isScratchFastPathTool(toolName: ToolName): boolean {
  return (
    toolName === "system.read_scratch" ||
    toolName === "system.write_scratch" ||
    toolName === "system.promote"
  );
}

function validateSystemToolAccess(args: {
  toolName: ToolName;
  caller: ToolExecuteContext["caller"];
}): string | null {
  if (args.toolName === "system.spawn_sub_agent" && args.caller !== "boss") {
    return "system.spawn_sub_agent can only be called by the boss";
  }
  if (args.toolName === "system.await_sub_agent" && args.caller !== "boss") {
    return "system.await_sub_agent can only be called by the boss";
  }
  return null;
}

async function resolveAwaitSubAgent(args: {
  parentRunId: string;
  userId: string;
  childRunId: string;
}): Promise<DispatchResult> {
  const outcome = await readChildRunOutcome(args);

  // Terminal child, an ownership/lookup error, or a child that has outrun the
  // wait-ceiling: hand the boss a real result to act on — never park. Shared
  // with the chat-turn finalization guard so the two join sites stay in lockstep.
  if (shouldResolveWithoutParking(outcome)) {
    return {
      kind: "executed",
      stagingId: null,
      toolResult: outcome,
      editedByUser: false,
    };
  }

  // Still running within the ceiling — park the parent on the child's
  // completion signal. On resume the await re-runs and reads the terminal
  // outcome (or re-parks if a spurious wake fired early).
  //
  // Schedule a dead-man wake at the ceiling BEFORE returning the park. The
  // in-band `sub_agent_done` signal is the happy-path waker, but it can be
  // lost (the child finishes in the gap before the executor commits
  // `waiting`), never fire (a cancelled child), or be swallowed by a worker
  // crash — and `findResumableRunIds` never sweeps `waiting`, so any of those
  // strands the boss forever. This timer is the only backstop that covers all
  // of them: when it fires the await re-reads the (terminal-by-then) child and
  // returns inline. It no-ops if the in-band signal already woke the parent.
  const scheduled = await scheduleSubAgentJoinWakeJob({
    childRunId: args.childRunId,
    parentRunId: args.parentRunId,
    delayMs: AWAIT_SUB_AGENT_CEILING_MS,
  });
  if (scheduled !== "scheduled") {
    // The dead-man timer is load-bearing, not best-effort: it is the ONLY thing
    // that revives a parent parked in `waiting` if the in-band `sub_agent_done`
    // signal is lost (`findResumableRunIds` never sweeps `waiting`). If we
    // couldn't schedule it ("failed" transient queue error, or "disabled" with
    // no queue at all), parking would risk an un-wakeable run — so don't park.
    // Hand the boss the still-running outcome instead: the turn ends honestly
    // ("the sub-agent is still running") rather than hanging forever.
    console.warn(
      "[await_sub_agent] dead-man wake not scheduled (",
      scheduled,
      ") — refusing to park",
      args.childRunId,
    );
    return {
      kind: "executed",
      stagingId: null,
      toolResult: { ...outcome, reason: "join_timer_unavailable" },
      editedByUser: false,
    };
  }
  return {
    kind: "parked",
    wake: { kind: "signal", name: subAgentDoneSignalName(args.childRunId) },
  };
}

function parseScratchAccessKey(key: string | null): ScratchToolKey | string {
  if (key === null) return "Scratch key must be a string";
  try {
    return parseScratchToolKey(key);
  } catch (err) {
    return toMessage(err);
  }
}

function readStringProp(input: unknown, prop: string): string | null {
  const value = getPath(input, prop);
  return typeof value === "string" ? value : null;
}
