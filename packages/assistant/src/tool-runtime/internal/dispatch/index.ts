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

import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  PolicyMode,
  ToolName,
  ToolRiskTier,
} from "@alfred/contracts";
import {
  APPROVAL_EXPIRY_MS,
  getPath,
  hashToolInput,
  hashToolRequest,
  INTEGRATION_ACTIONS,
  integrationFromToolName,
  inputMatchesWorkflowResourceScope,
  isIntegrationSlug,
  isRecord,
  isTerminalStatus,
  isToolName,
  isToolRiskTier,
  isUnknownEffectEnvelope,
  jsonValueSchema,
  sanitizeErrorMessage,
  sanitizeToolResult,
  summarizeBody,
  toJsonValue,
  toMessage,
  cancellationEnvelopeSchema,
  unknownEffectEnvelopeSchema,
  type CancellationEnvelope,
  type CancellationFence,
  type ToolUnavailabilityCode,
  type UnknownEffectEnvelope,
} from "@alfred/contracts";
import {
  recordDispatchRejection,
  startToolSpan,
  type DispatchRejectionInput,
  type DispatchRejectionOutcome,
  type ToolSpanCloser,
  type ToolSpanInput,
} from "@alfred/ai";
import { stagingStore, type StagingCommit, type StagingRow } from "./staging-store";
import {
  callerLabel,
  joinToolInput,
  registerToolCallRoundAdapter,
  type ToolCallDispatchArgs,
} from "@alfred/assistant/tool-runtime";
import {
  APP_ERROR_REGISTRY,
  isAppErrorCode,
  publicAppError,
  toPublicAppError,
  type PublicAppError,
} from "@alfred/contracts/app-errors";
import { logger, safeErrorDiagnostic } from "@alfred/logging";
import { enrichInvalidInputMessage } from "./invalid-input";
import { normalizeToolInputKeys } from "./normalize-keys";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { resolveApprovalNotifyDelayMs, resolvePolicyMode } from "@alfred/assistant/action-policies";
import {
  resolveAwaitSubAgent,
  scheduleApprovalExpiryJob,
  scheduleApprovalNotificationJob,
} from "../../index";
import { parseScratchToolKey, type ScratchToolKey } from "../tools/scratch-key";
import {
  countRunPassthroughCalls,
  PASSTHROUGH_PER_RUN_CEILING,
  passthroughBudgetExhausted,
  passthroughTruncationTelemetry,
} from "../tools/passthrough";
import { toolExecuteContext } from "../../context";
import {
  getTool,
  resolveToolAvailability,
  type RegisteredTool,
  type ToolExecuteContext,
} from "../registry";
import { readIntegrationAvailability } from "@alfred/assistant/connections";
import { resolveTimezone } from "@alfred/assistant/settings";

type DispatchToolCallRoundAdapter = Parameters<typeof registerToolCallRoundAdapter>[0];
export type ToolCallDispatchResult = Awaited<ReturnType<DispatchToolCallRoundAdapter["dispatch"]>>;
type DispatchResult = ToolCallDispatchResult;

const UNKNOWN_TOOL_TRACE_NAME = "<unknown>";
const TOOLISH_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;
const TOOL_RISK_RANK = {
  no_risk: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const satisfies Record<ToolRiskTier, number>;
let dispatchRejectionRecorder: (args: DispatchRejectionInput) => void = recordDispatchRejection;
let toolSpanStarter: (args: ToolSpanInput) => ToolSpanCloser = startToolSpan;
let integrationAvailabilityReader: (userId: string) => Promise<IntegrationAvailabilitySnapshot> =
  readIntegrationAvailability;

/** Zod-issue shape we read for the rejection signature (loose by design). */
type RejectionIssue = { code?: string; path?: readonly PropertyKey[] };

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

export function _setIntegrationAvailabilityReaderForTests(
  reader: (userId: string) => Promise<IntegrationAvailabilitySnapshot>,
): () => void {
  const previous = integrationAvailabilityReader;
  integrationAvailabilityReader = reader;
  return () => {
    integrationAvailabilityReader = previous;
  };
}

export function buildDispatchRejectionTraceInput(args: {
  dispatch: ToolCallDispatchArgs;
  outcome: DispatchRejectionOutcome;
  reason: string;
  issues?: readonly RejectionIssue[] | undefined;
  /** Safe grouping identity. Raw undeclared names must use `<unknown>`. */
  toolName?: string | undefined;
  /** Optional sanitized + bounded model-supplied name hint for unknown tools. */
  candidateToolName?: string | undefined;
  /** Actual payload rejected by this branch. Callers must pass only payloads safe for trace I/O. */
  input?: unknown;
  /** Present only when `input` is already schema-valid for this tool. */
  tool?: RegisteredTool | undefined;
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
 * (#345). Pulls the common identity off `ToolCallDispatchArgs` so each early-return
 * branch is a one-liner. Fire-and-forget — `recordDispatchRejection` swallows
 * everything, so this can never affect the dispatch result.
 */
function recordRejection(args: {
  dispatch: ToolCallDispatchArgs;
  outcome: DispatchRejectionOutcome;
  reason: string;
  issues?: readonly RejectionIssue[] | undefined;
  toolName?: string | undefined;
  candidateToolName?: string | undefined;
  input?: unknown;
  tool?: RegisteredTool | undefined;
}): void {
  dispatchRejectionRecorder(buildDispatchRejectionTraceInput(args));
}

/**
 * The one place a {@link ToolUnavailabilityCode} becomes a dispatch result, so
 * the availability evaluator stays the sole authority on *whether* a tool may
 * run and this decides only how the refusal is carried.
 *
 * Two arms because they route differently downstream, not because the reasons
 * differ in kind. `feature_disabled` is hidden plumbing — the user turned the
 * ADR-0074 tier off and the model must not narrate a capability they disabled —
 * while every other code is a real, explainable obstacle ("Gmail needs to be
 * reconnected") the model should surface. Both are `nonExecution` (see
 * `isNonExecutionFailure`): neither reached the side-effect path, so neither
 * counts against the #346 honesty guard.
 */
function unavailableToolResult(args: {
  toolName: ToolName;
  integration: IntegrationSlug;
  code: ToolUnavailabilityCode;
  reason: string;
}): DispatchResult {
  if (args.code === "feature_disabled") {
    return {
      kind: "feature_disabled",
      result: {
        status: "feature_disabled",
        toolName: args.toolName,
        integration: args.integration,
        message: args.reason,
      },
    };
  }
  return {
    kind: "not_allowed",
    result: {
      status: "not_allowed",
      toolName: args.toolName,
      integration: args.integration,
      message: args.reason,
    },
  };
}

export async function dispatchToolCall(args: ToolCallDispatchArgs): Promise<DispatchResult> {
  const caller = args.caller;
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

  if (args.allowedTools && !args.allowedTools.includes(toolName)) {
    const message = `Tool '${toolName}' is outside this workflow revision's approved capability envelope.`;
    recordRejection({ dispatch: args, outcome: "not_allowed", reason: message, toolName });
    return {
      kind: "not_allowed",
      result: { status: "capability_mismatch", toolName, integration, message },
    };
  }

  const workflowCapabilities = args.allowedTools
    ? (args.requiredCapabilities?.filter((capability) => capability.tool === toolName) ?? [])
    : [];
  if (args.allowedTools && workflowCapabilities.length !== 1) {
    const message = `Tool '${toolName}' does not have one exact approved capability binding.`;
    recordRejection({ dispatch: args, outcome: "not_allowed", reason: message, toolName });
    return {
      kind: "not_allowed",
      result: { status: "capability_mismatch", toolName, integration, message },
    };
  }

  // The declared tool contract, enforced where it decides. `callers`,
  // `requiresLiveChat`, `passthrough`, `credential` and the workflow integration
  // cap are declared once on the registration and evaluated by ONE evaluator, so
  // discovery, load, the SDK projection and this floor agree by construction —
  // no branch here re-derives a permission from a tool name.
  //
  // Unconditional on purpose. The surface the model was shown was built at turn
  // start; a grant revoked, a workflow cap narrowed, or an ADR-0074 kill switch
  // flipped since then must bounce the call, and a tool auto-activated by an
  // inactive bounce (#407) never passed the surface's checks at all. Two things
  // keep it cheap: the read is lazy inside `resolveToolAvailability` (a `system.*`
  // or `mcp.*` call resolves from the registration alone and costs no query), and
  // `readIntegrationAvailability` memoizes per user for a few seconds, so a round
  // of parallel calls into one integration shares a single snapshot.
  const availability = await resolveToolAvailability({
    tool,
    allowed: new Set(args.allowedIntegrations ?? []),
    context: args.runContext,
    loadSnapshot: () => integrationAvailabilityReader(args.userId),
  });
  if (!availability.available) {
    recordRejection({
      dispatch: args,
      outcome: availability.code === "feature_disabled" ? "feature_disabled" : "not_allowed",
      reason: availability.reason,
      toolName,
    });
    return unavailableToolResult({
      toolName,
      integration,
      code: availability.code,
      reason: availability.reason,
    });
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
  if (normalized.renamed.length > 0) {
    // Surface the auto-repaired keys so prod traces can measure how often the
    // ergonomics pass fires, and on which tools/keys, without re-running the
    // 400-run scan — this is the signal for whether the tolerance is earning
    // its keep or a schema key drifted from what the model reaches for.
    logger.debug(
      { event: "tool_input_keys_normalized", toolName, renamed: normalized.renamed },
      "Normalized tool-input param keys before validation",
    );
  }
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
  const approvedResourceScope = workflowCapabilities[0]?.resourceScope;
  if (approvedResourceScope && !inputMatchesWorkflowResourceScope(input, approvedResourceScope)) {
    const message = `Tool '${toolName}' input is outside this workflow revision's approved resource boundary.`;
    recordRejection({ dispatch: args, outcome: "not_allowed", reason: message, toolName });
    return {
      kind: "not_allowed",
      result: { status: "capability_mismatch", toolName, integration, message },
    };
  }
  // `toolExecuteContext` derives the provider bind from `userId`, so every
  // provider client this call reaches is wired to THIS user's credentials and no
  // tool resolves a credential itself. The bind is lazy — nothing is built and no
  // credential read unless the tool actually calls one.
  const ctx = toolExecuteContext({
    runId: args.runId,
    scratchpadRunId: args.scratchpadRunId ?? args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    userId: args.userId,
    timezone: args.timezone ?? (await resolveTimezone(args.userId)),
    caller,
    runContext: args.runContext,
    threadId: args.threadId,
    messageId: args.messageId,
    allowedIntegrations: args.allowedIntegrations,
    accountRef: workflowCapabilities[0]?.accountRef,
  });
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
  // Routing declared by the registration (`RegisteredTool.staging`), not
  // re-derived from the tool name here. Both non-default arms intercept BEFORE
  // the staging/execute path below; everything else falls through to it. The
  // availability and active-surface checks above already authorized the call, so
  // the bypass is of the approval gate only.
  switch (tool.staging) {
    case "join":
      // ADR-0073. Park the parent on the child's completion signal instead of
      // returning a result the boss would have to poll. A terminal (or
      // timed-out) child returns its real outcome inline.
      return await resolveAwaitSubAgentWithSpan(tool, input, ctx);
    case "fast_path":
      return executeFastPath(tool, input, ctx);
    case "staged":
      break;
    default: {
      // A fourth policy must not silently inherit the staged path — the whole
      // point of declaring routing is that extending it is a decision.
      const unhandled: never = tool.staging;
      throw new Error(
        `[dispatch] unhandled staging policy '${String(unhandled)}' on '${toolName}'`,
      );
    }
  }

  const proposedInputHash = hashToolInput(toolName, input);

  // #559b: recheck the cancellation fence before any staging write. The step
  // started under `args.fence`; `cancelRunInTx` bumps the run's generation
  // the moment it lands, so a current value past the captured one means the run
  // was cancelled while this step was in flight. Refuse BEFORE the barrier and
  // the status machine: no new approval may be raised and no staging row may be
  // written on a cancelled run (the #530 re-fire and the effect-after-cancel
  // hole). The barrier, retry, status, and upsert awaits below re-open the
  // window this read closes, so `executeAndCommit` reads the fence a second
  // time immediately before `tool.execute`. Reads keep the fast path and are
  // not fenced — they have no external effect.
  const fence = await stagingStore().readCancellationFence(args.runId);
  if (fence.generation > args.fence.generation) {
    return {
      kind: "fenced",
      stagingId: null,
      result: synthesizeCancelledByFence(),
    };
  }

  // #559a: the canonical request hash scopes the effect to the account/resource
  // it lands on, so the same args against a different target are a different
  // effect. Non-workflow calls have no resolved account ref yet — the target
  // binding is appended when the gate knows it.
  const requestHash = hashToolRequest(toolName, input, ctx.accountRef);

  // #559a: the ambiguity barrier. BEFORE inserting a fresh row, ask whether an
  // identical logical effect (same user + canonical request) is still marked
  // `unknown`. If it is, a new tool-call id must not slip past it: the write
  // may have been delivered but never confirmed, so repeating it risks a
  // duplicate. The model receives the same non-actionable unknown envelope the
  // MCP broker produces, and no staging row is written.
  const unresolvedBarrier = await stagingStore().findUnresolvedUnknown({
    userId: args.userId,
    requestHash,
  });
  if (unresolvedBarrier) {
    return {
      kind: "blocked",
      stagingId: null,
      result: synthesizeBlockedByUnknownEffect(),
    };
  }

  // Retry suppression — Phase 3c. A prior `rejected` row for this run +
  // tool + input hash means the user has already said no to this exact
  // proposal; synthesize the same rejection without writing a new row
  // or firing a new notification. Limited to the same run because
  // ADR-0034 scopes the partial index that way.
  const priorReject = await stagingStore().findPriorRejection({
    runId: args.runId,
    toolName,
    proposedInputHash,
  });

  if (priorReject) {
    const reason = priorReject.reason ?? "rejected by user";
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

  // Cancellation is allowed while a step body is running. The staging insert
  // below is its own autocommit, so the executor's later commit guard cannot
  // roll it back. Check at the effect boundary; the cancel post-commit sweep
  // and the losing executor repeat the cleanup to close the remaining race.
  // `null` covers both an absent run and an unparseable status — the store owns
  // that distinction and the gate treats either as "the run is unavailable".
  const runStatus = await stagingStore().readRunStatus(args.runId);
  if (runStatus === null || isTerminalStatus(runStatus)) {
    const reason = runStatus === null ? "run is unavailable" : `run is already ${runStatus}`;
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

  // Most tools carry a static `riskTier`. A tool may instead resolve its
  // EFFECTIVE tier from validated input at the gate: Calendar raises an invite
  // from medium to high, while `mcp.call` can use a reviewed per-descriptor
  // downgrade (#541). The central resolver clamps undeclared downgrades. The
  // effective tier drives both the approval decision and the persisted row.
  const riskTier = await resolveEffectiveRiskTier(tool, input, ctx);
  const policyMode = await resolvePolicyMode(args.userId, toolName);
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

  // Single upsert, idempotent on `(run_id, tool_call_id)`; the store owns the
  // conflict idiom and the `wasInserted` verdict the Replicache poke is gated
  // on. The stored row comes back verbatim on conflict, which is what the
  // resume path below reads `status` / `decidedInput` off.
  // #293: redact secrets from the persisted `proposed_input` — but ONLY for an
  // autonomous call. A gated tool's `proposed_input` doubles as the
  // approval-resume payload (the `approved` branch below re-executes from it when
  // the user didn't edit), so redacting it would corrupt resume. fetch_url is
  // autonomous, so it always takes the redacted branch; the guard is the seam for
  // a future gated secret-bearing tool. The hash + execute always use raw `input`.
  const proposedInputForRow =
    !requiresApproval && tool.redactInput ? tool.redactInput(input) : input;
  const persistedProposedInput = jsonValueSchema.parse(proposedInputForRow);
  const upserted = await stagingStore().upsertStaging({
    userId: args.userId,
    runId: args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    toolName,
    integration,
    riskTier,
    proposedInput: persistedProposedInput,
    proposedInputHash,
    requestHash,
    requiresApproval,
    status: "pending",
    notifyAfterAt,
    expiresAt,
  });
  let row = upserted.row;
  const insertedNew = upserted.wasInserted;
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
  let promotedPendingApproval = false;
  const riskFloorRequiresApproval = toolRequiresApproval("autonomy", riskTier);
  if (
    !insertedNew &&
    row.status === "pending" &&
    riskFloorRequiresApproval &&
    !row.requiresApproval
  ) {
    const promoted = await stagingStore().promotePendingApproval(row.id, {
      riskTier,
      proposedInput: persistedProposedInput,
      proposedInputHash,
      notifyAfterAt,
      expiresAt,
    });
    if (!promoted) {
      throw new Error(
        `[dispatch] pending approval promotion failed closed (run=${args.runId}, toolCallId=${args.toolCallId})`,
      );
    }
    row = promoted;
    promotedPendingApproval = true;
  }
  switch (row.status) {
    case "pending":
      // Approval requirements are monotonic while a row is pending. The
      // promotion above lets a newly-raised risk floor add a gate, while this
      // stored value prevents a later policy change (gated → autonomy) from
      // removing one. Policy changes apply normally to fresh calls, but an
      // in-flight call can only become safer. See ADR-0034 / ADR-0088.
      if (row.requiresApproval) {
        // Park. The executor emits the transient `approval.requested`
        // event when it commits the interrupt; Replicache carries the
        // durable approvals queue. Emit the poke only when the row first enters
        // that queue, by insertion or promotion, so ordinary resumes do not spam
        // connected clients.
        if (insertedNew || promotedPendingApproval) emitReplicachePokes([args.userId], row.id);
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
      {
        const exhausted = await guardPassthroughBudget(row, tool, ctx);
        if (exhausted) return exhausted;
      }
      return executeAndCommit(row, tool, input, ctx, {
        expectedFence: args.fence,
        editedByUser: false,
      });

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
        const error = toPublicAppError(undefined, "tool_input_invalid");
        await commitAndPoke(row, ctx, {
          status: "failed",
          outcome: "failed",
          error,
          executedAt: new Date(),
        });
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
      {
        const exhausted = await guardPassthroughBudget(row, tool, ctx);
        if (exhausted) return exhausted;
      }
      return executeAndCommit(row, tool, reparsed.data as unknown, ctx, {
        expectedFence: args.fence,
        editedByUser,
      });
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
 * Resolve input-dependent risk without letting a new resolver silently lower
 * its tool's approval floor. Intentional downgrades are reviewed declarations
 * on the tool and are logged without the proposed input (ADR-0088).
 */
export async function resolveEffectiveRiskTier(
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<ToolRiskTier> {
  if (!tool.resolveRiskTier) return tool.riskTier;

  const resolved: unknown = await tool.resolveRiskTier(input, ctx);
  if (!isToolRiskTier(resolved)) {
    logger.warn(
      {
        event: "tool_risk_tier_invalid",
        toolName: tool.name,
        staticRiskTier: tool.riskTier,
        runId: ctx.runId,
      },
      "Ignored invalid resolved tool risk tier",
    );
    return tool.riskTier;
  }
  const staticRank = TOOL_RISK_RANK[tool.riskTier];
  const resolvedRank = TOOL_RISK_RANK[resolved];
  if (resolvedRank >= staticRank) return resolved;

  if (!tool.riskTierDowngradeReason) {
    logger.warn(
      {
        event: "tool_risk_tier_downgrade_clamped",
        toolName: tool.name,
        staticRiskTier: tool.riskTier,
        attemptedRiskTier: resolved,
        runId: ctx.runId,
      },
      "Clamped undeclared tool risk-tier downgrade",
    );
    return tool.riskTier;
  }

  logger.info(
    {
      event: "tool_risk_tier_downgrade",
      toolName: tool.name,
      staticRiskTier: tool.riskTier,
      resolvedRiskTier: resolved,
      reason: tool.riskTierDowngradeReason,
      runId: ctx.runId,
    },
    "Applied reviewed tool risk-tier downgrade",
  );
  return resolved;
}

/**
 * Best-effort prediction of whether a *fresh* dispatch of this tool would gate
 * (stage for approval) instead of executing autonomously. Mirrors the policy +
 * STATIC risk-tier gate in {@link dispatchToolCall} by calling the same two
 * functions it calls: `resolvePolicyMode` and {@link toolRequiresApproval}.
 *
 * `resolvePolicyMode` owns the `system.*` rule — it answers `autonomy` for those
 * tools before it reads anything, so this function needs no carve-out of its own
 * and performs no policy read for them. A `system.*` tool can therefore still be
 * reported as gating: `system.activate_workflow` is `high`-tier, and the ADR-0069
 * floor outranks autonomy.
 *
 * Two arms it does NOT mirror, both over-reports:
 *   - a tool with `resolveRiskTier` (see below) — no validated input here.
 *   - `staging: "fast_path"`, which returns from `dispatchToolCall` before the
 *     gate. `mcp.list_tools` is the one holder.
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
  const policyMode = await resolvePolicyMode(userId, toolName);
  const tool = getTool(toolName);
  if (!tool) return false;
  // The hint has no validated input or execution context. Keep any dynamic
  // resolver in the serial approval lane; the live dispatch remains the source
  // of truth and may still execute a lower-tier call without parking.
  if (tool.resolveRiskTier) return true;
  return toolRequiresApproval(policyMode, tool.riskTier);
}

const dispatchToolCallRoundAdapter: DispatchToolCallRoundAdapter = {
  dispatch: dispatchToolCall,
  wouldWaitForApproval: toolCallWouldGate,
  executionLane(toolName) {
    if (!isToolName(toolName)) return null;
    return getTool(toolName)?.executionLane ?? null;
  },
};

/** Install the guarded dispatcher as tool-runtime's call-round adapter at boot. */
export function registerDispatchToolCallRoundAdapter(): void {
  registerToolCallRoundAdapter(dispatchToolCallRoundAdapter);
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
  const loadHint = suggestion.toolName
    ? `Call system.load_tool with name '${suggestion.toolName}' first,`
    : `Call system.search_tools for '${suggestion.integration}' to choose an exact tool, then call system.load_tool with its returned name.`;
  return [
    `Tool '${toolName}' is not declared.`,
    validActions,
    retry,
    loadHint,
    suggestion.toolName === null ? null : `then retry '${suggestion.toolName}'.`,
    "Do not ask the user to load a tool.",
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
  // so enumerate the integration's tools and point at exact search/load; the
  // model picks the right `integration.action` on retry.
  if (isIntegrationSlug(input) && input !== "system") {
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(input)) {
      return null;
    }
    // No tools to point at — recovering would loop the boss through a
    // a discovery loop that yields nothing callable (#286 review).
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
    caller: callerLabel(ctx.caller),
    stepId: ctx.stepId,
    // #293: the trace/span sink ALWAYS gets the redacted input — unlike
    // `proposed_input`, a span is never a resume payload, so there's no gated
    // exception. `execute` below still receives the raw `input`.
    input: tool.redactInput ? tool.redactInput(input) : input,
    startedAt: new Date(),
  });
  try {
    const result = await tool.execute(input, ctx);
    // ADR-0074 thermometer: a clipped passthrough result carries a
    // `handleEligible` truncation marker. Fold the structured signal onto the
    // tool span's metadata (recorded even with I/O capture off) and mirror it to
    // a log line so the L0-trigger review can be answered without Langfuse I/O.
    const thermometer = passthroughTruncationTelemetry(tool.name, ctx.runId, result);
    if (thermometer) {
      logger.info(
        { event: "passthrough_truncation", ...thermometer },
        "Passthrough result truncated",
      );
      span.success(result, { thermometer });
    } else {
      span.success(result);
    }
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
  // PARSED, not cast. This arm is selected by a declared `staging: "join"`, so
  // the guarantee that `childRunId` is here comes from the join contract
  // (`joinToolInput`, proven for every declarer at boot) rather than from the
  // `toolName === "system.await_sub_agent"` equality this replaced. Parse before
  // the span opens so a contract violation can't leave a span dangling.
  const { childRunId } = joinToolInput.parse(input);
  const span = toolSpanStarter({
    runId: ctx.runId,
    toolName: tool.name,
    toolCallId: ctx.toolCallId,
    userId: ctx.userId,
    caller: callerLabel(ctx.caller),
    stepId: ctx.stepId,
    input: tool.redactInput ? tool.redactInput(input) : input,
    startedAt: new Date(),
  });
  try {
    const result = await resolveAwaitSubAgent({
      parentRunId: ctx.runId,
      userId: ctx.userId,
      childRunId,
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

type ParkedDispatchResult = Extract<DispatchResult, { kind: "parked" }>;
type FailedDispatchResult = Extract<DispatchResult, { kind: "failed" }>;

type SubAgentSpanOutput =
  | { status: "executed"; toolResult: unknown }
  | { status: "parked"; wake: ParkedDispatchResult["wake"] }
  | { status: "failed"; error: FailedDispatchResult["error"] }
  | { status: Exclude<DispatchResult["kind"], "executed" | "parked" | "failed"> };

function awaitSubAgentSpanOutput(result: DispatchResult): SubAgentSpanOutput {
  switch (result.kind) {
    case "executed":
      return { status: "executed", toolResult: result.toolResult };
    case "parked":
      return { status: "parked", wake: result.wake };
    case "failed":
      return { status: "failed", error: result.error };
    default:
      return { status: result.kind };
  }
}

/**
 * ADR-0074 per-run passthrough ceiling. Before a passthrough tool executes,
 * count how many raw passthrough calls already ran in this run; at or over the
 * ceiling, DON'T execute — commit the staged row with a VISIBLE
 * `budget_exhausted` envelope and return it as a normal `executed` result so the
 * boss reads it and stops paginating (never a silent drop). Returns `null` for a
 * non-passthrough tool or when the run is under budget, so the caller proceeds
 * to a real execution. Persisting the envelope on the row keeps replay idempotent
 * (a re-dispatch hits the `executed` short-circuit and re-serves the same notice).
 */
async function guardPassthroughBudget(
  row: StagingRow,
  tool: ReturnType<typeof getTool> & object,
  ctx: ToolExecuteContext,
): Promise<DispatchResult | null> {
  if (!tool.availability?.passthrough) return null;
  const priorCalls = await countRunPassthroughCalls(ctx.runId);
  if (priorCalls < PASSTHROUGH_PER_RUN_CEILING) return null;
  const envelope = passthroughBudgetExhausted(priorCalls);
  const persistedEnvelope = jsonValueSchema.parse(envelope);
  // The envelope is minted here, never through the tool, so it cannot carry
  // persistence poison — `sanitized: false` is the verdict, not a default.
  await commitAndPoke(row, ctx, {
    status: "executed",
    outcome: "succeeded",
    result: persistedEnvelope,
    sanitized: false,
    executedAt: new Date(),
  });
  return {
    kind: "executed",
    stagingId: row.id,
    toolResult: persistedEnvelope,
    editedByUser: false,
  };
}

/**
 * The only door onto a terminal staging write. Committing and poking are one
 * step because they must stay in that order and must never be separated: the
 * poke tells a connected client to re-pull the approvals queue, so a poke that
 * beats its commit shows the row in its pre-terminal state. Gated on the row's
 * `requires_approval` because an autonomous row was never in that queue.
 */
async function commitAndPoke(
  row: StagingRow,
  ctx: ToolExecuteContext,
  commit: StagingCommit,
): Promise<void> {
  await stagingStore().commitStaging(row.id, commit);
  if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
}

async function executeAndCommit(
  row: StagingRow,
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
  opts: { expectedFence: CancellationFence; editedByUser: boolean },
): Promise<DispatchResult> {
  // #559b: the second fence read, immediately before the effect. The gate's
  // first read refuses a step whose cancel landed before dispatch; this one
  // refuses a cancel that landed DURING dispatch — the barrier, retry, status,
  // and upsert awaits sit between the two. The staging row already exists
  // here, so close it `failed`/`refused` rather than leave a pending/approved
  // row claiming an effect that will never resolve. The residual window between
  // this read and the provider call inside `tool.execute` is irreducible
  // without transactional effects; this narrows it to one DB round-trip.
  const fence = await stagingStore().readCancellationFence(ctx.runId);
  if (fence.generation > opts.expectedFence.generation) {
    await commitAndPoke(row, ctx, {
      status: "failed",
      outcome: "refused",
      error: publicAppError("run_cancelled"),
      executedAt: new Date(),
    });
    return {
      kind: "fenced",
      stagingId: row.id,
      result: synthesizeCancelledByFence(),
    };
  }
  let result: unknown;
  let error: PublicAppError | undefined;
  try {
    // Thread the committing staging row id to execution. Only the staged path
    // has one; the fast path (executeFastPath) intentionally leaves it undefined.
    // The MCP broker mints its durable ledger row 1:1 with this staging row.
    result = await executeToolWithSpan(tool, input, { ...ctx, stagingId: row.id });
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
    await commitAndPoke(row, ctx, {
      status: "failed",
      outcome: "failed",
      error,
      executedAt: now,
    });
    return { kind: "failed", stagingId: row.id, error };
  }
  // ADR-0070 §1.1: sanitize at the dispatch boundary, the instant the tool
  // returns and before the value touches any persisted sink. This cleans the
  // `execute_result` jsonb write below AND the `toolResult` returned to the
  // caller (which flows into the transcript/state — the same poison sinks).
  const sanitizedResult = sanitizeToolResult(result);
  const persistedResult = toJsonValue(sanitizedResult.value);
  const didSanitize = sanitizedResult.removed > 0 || sanitizedResult.collisions > 0;
  if (didSanitize) {
    console.warn(
      `[dispatch] sanitized ${sanitizedResult.removed} poison code unit(s)` +
        `${sanitizedResult.collisions > 0 ? `, ${sanitizedResult.collisions} key collision(s)` : ""}` +
        ` from ${tool.name} result`,
    );
  }
  // #559a: an executed write that returns the unknown-outcome envelope (today
  // only the MCP broker's ambiguous attempt) is recorded as `unknown`, not
  // `succeeded` — it may have been delivered without confirmation, which is
  // exactly the case the ambiguity barrier must hold against.
  const outcome = isUnknownEffectEnvelope(persistedResult) ? "unknown" : "succeeded";
  await commitAndPoke(row, ctx, {
    status: "executed",
    outcome,
    result: persistedResult,
    sanitized: didSanitize,
    executedAt: now,
  });
  return {
    kind: "executed",
    stagingId: row.id,
    toolResult: persistedResult,
    editedByUser: opts.editedByUser,
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
    const jsonResult = toJsonValue(sanitized.value);
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
      toolResult: jsonResult,
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

/**
 * #559a: the ambiguity-barrier envelope. An identical logical effect is still
 * `unknown` — possibly delivered, never confirmed — so this call must not be
 * attempted. Minted through the shared schema so the barrier's shape is exactly
 * the one `isUnknownEffectEnvelope` recognizes and the MCP broker produces.
 */
function synthesizeBlockedByUnknownEffect(): UnknownEffectEnvelope {
  return unknownEffectEnvelopeSchema.parse({
    status: "unknown",
    retry: "blocked",
    message:
      "An identical request was already dispatched and may have been delivered without confirmation. " +
      "It will not be repeated until its outcome is confirmed or explicitly superseded. " +
      "Check the target's state instead of retrying.",
  });
}

function synthesizeCancelledByFence(): CancellationEnvelope {
  return cancellationEnvelopeSchema.parse({
    status: "cancelled",
    retry: "never",
    message:
      "The run was cancelled while this call was pending. It did not run and " +
      "will not be repeated; do not re-issue it.",
  });
}

function synthesizeRejection(
  args: SynthesizeRejectionArgs,
): Extract<DispatchResult, { kind: "rejected" }>["result"] {
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
    // Who may call it is `availability.callers: ["boss"]` on the registration,
    // already enforced at the floor. What remains here is the input-shaped part:
    // which scratch keys a promote may name.
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
