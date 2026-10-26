/**
 * Every tool call goes through `dispatchToolCall`: validate, check for repeats,
 * apply policy, then write an `action_stagings` row and execute or park.
 * `join` and `fast_path` tools execute inline with no row (ADR-0034, ADR-0069).
 */

import type {
  AskUserUnansweredReason,
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  ToolName,
  ToolRiskTier,
} from "@alfred/contracts";
import {
  APPROVAL_EXPIRY_MS,
  hashToolInput,
  hashToolRequest,
  INTEGRATION_ACTIONS,
  INTEGRATION_SLUGS,
  integrationFromToolName,
  inputMatchesWorkflowResourceScope,
  isIntegrationSlug,
  isTerminalStatus,
  isToolName,
  isToolRiskTier,
  isUnknownEffectEnvelope,
  joinToolInput,
  jsonValueSchema,
  sanitizeErrorMessage,
  sanitizeToolResult,
  summarizeBody,
  toJsonValue,
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
import {
  stagingStore,
  type PriorRejectionStatus,
  type StagingCommit,
  type StagingRow,
} from "./staging-store";
import { STAGING_ARM, type GatedArmPolicy } from "./staging-arm";
import type { RejectedToolResult, UnansweredQuestionsToolResult } from "../adapter";
import {
  callerLabel,
  questionToolInput,
  registerToolCallRoundAdapter,
  type ToolCallDispatchArgs,
} from "@alfred/assistant/tool-runtime";
import {
  publicAppError,
  publicAppErrorFromStored,
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
import {
  countRunPassthroughCalls,
  PASSTHROUGH_PER_RUN_CEILING,
  passthroughBudgetExhausted,
  passthroughTruncationTelemetry,
} from "../tools/passthrough";
import { toolExecuteContext } from "../../context";
import { toolCallWouldGate, toolRequiresApproval } from "../../approval-rule";
import {
  getTool,
  resolveToolAvailability,
  type BoundToolCall,
  type RegisteredTool,
  type ToolExecuteContext,
} from "../registry";
import { readIntegrationAvailability } from "@alfred/assistant/connections";
import { settings } from "@alfred/assistant/settings";

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

type RejectionIssue = { code?: string; path?: readonly PropertyKey[] };

/**
 * PII-free fingerprint of a rejection. Adds sorted Zod `code@path` pairs, so
 * the same broken input repeated gives one countable signature.
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a `PropertyKey` is a string, number or symbol; the symbol arm has no text form.
  if (typeof part === "symbol") return "symbol";

  return String(part);
}

function safeUnknownToolCandidate(toolName: string): string | undefined {
  const trimmed = toolName.trim();

  if (trimmed.length === 0 || trimmed.length > 120 || !TOOLISH_NAME.test(trimmed)) return undefined;

  return summarizeBody(sanitizeErrorMessage(trimmed), 120);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- a tool's redacted input is free-form at the registry seam; it goes to the trace as received.
function redactTraceInput(call: BoundToolCall): unknown {
  try {
    return call.redactedInput();
  } catch (err) {
    logger.warn({ err }, "[dispatch] tool input redaction failed");

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
  /** Sanitized, bounded name the model asked for, for unknown tools. */
  candidateToolName?: string | undefined;
  /** The rejected call. Only its redacted input reaches the trace; an unparsed input never does. */
  call?: BoundToolCall | undefined;
  startedAt?: Date;
}): DispatchRejectionInput {
  const toolName = args.toolName ?? args.dispatch.toolName;
  const input = args.call ? redactTraceInput(args.call) : undefined;

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

/** Trace a call that stopped before execute. Never throws: the recorder swallows errors. */
function recordRejection(args: {
  dispatch: ToolCallDispatchArgs;
  outcome: DispatchRejectionOutcome;
  reason: string;
  issues?: readonly RejectionIssue[] | undefined;
  toolName?: string | undefined;
  candidateToolName?: string | undefined;
  call?: BoundToolCall | undefined;
}): void {
  dispatchRejectionRecorder(buildDispatchRejectionTraceInput(args));
}

/**
 * Turn a {@link ToolUnavailabilityCode} into a dispatch result.
 * `feature_disabled` stays hidden: the user turned the ADR-0074 tier off, so the
 * model must not mention it. Other codes are obstacles the model should explain.
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
    // Only the availability floor sets this. Policy refusals must not cause a connect nudge.
    unavailability: args.code,
  };
}

/** A stage either settles the call with a result or continues with the next state. */
export type DispatchStageOutcome<Next> = DispatchResult | { readonly continueWith: Next };

export type DispatchStage<In, Next> = (input: In) => Promise<DispatchStageOutcome<Next>>;

function continueWith<Next>(next: Next) {
  return { continueWith: next };
}

function isContinue<Next>(
  outcome: DispatchStageOutcome<Next>,
): outcome is { readonly continueWith: Next } {
  return "continueWith" in outcome;
}

interface ResolvedDispatch {
  args: ToolCallDispatchArgs;
  toolName: ToolName;
  tool: RegisteredTool;
  integration: IntegrationSlug;
  workflowCapabilities: NonNullable<ToolCallDispatchArgs["requiredCapabilities"]>;
}

interface ValidatedDispatch extends ResolvedDispatch {
  call: BoundToolCall;
  ctx: ToolExecuteContext;
  arm: GatedArmPolicy;
}

interface SuppressedDispatch extends ValidatedDispatch {
  proposedInputHash: string;
  requestHash: string;
}

/**
 * Run the four stages in order: resolve, validate, suppress repeats, then stage
 * or resume. Approval resume uses this same entry point.
 */
export async function dispatchToolCall(args: ToolCallDispatchArgs): Promise<DispatchResult> {
  const registry = await resolveRegistryStage(args);

  if (!isContinue(registry)) return registry;

  const validated = await validateInputStage(registry.continueWith);

  if (!isContinue(validated)) return validated;

  const suppressed = await suppressRepeatedStage(validated.continueWith);

  if (!isContinue(suppressed)) return suppressed;

  const terminal = await stageOrResumeStage(suppressed.continueWith);

  // Always settles: `continueWith` is `never` here.
  if (!isContinue(terminal)) return terminal;

  return terminal.continueWith;
}

/** Stage 1: find the tool, then check the workflow envelope, availability, and the active surface. */
const resolveRegistryStage: DispatchStage<ToolCallDispatchArgs, ResolvedDispatch> = async (
  args,
) => {
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

  // Always re-check: the surface was built at turn start, and a grant, cap, or
  // kill switch can change since then. Cheap: the snapshot read is lazy and
  // memoized per user for a few seconds.
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

  return continueWith({ args, toolName, tool, integration, workflowCapabilities });
};

/** Stage 2: validate input, then run `join` and `fast_path` tools inline. */
const validateInputStage: DispatchStage<ResolvedDispatch, ValidatedDispatch> = async (resolved) => {
  const { args, toolName, tool, integration, workflowCapabilities } = resolved;
  const caller = args.caller;

  // Fix key casing (`max_results` -> `maxResults`). Use the model-facing schema:
  // the runtime one for `system.ask_user` also has the user's `answers` (ADR-0099).
  const normalized = normalizeToolInputKeys(args.input, tool.modelInputSchema);

  if (normalized.renamed.length > 0) {
    // Shows how often this repair fires, and on which keys.
    logger.debug(
      { event: "tool_input_keys_normalized", toolName, renamed: normalized.renamed },
      "Normalized tool-input param keys before validation",
    );
  }

  const binding = tool.bind(normalized.input);

  if (!binding.success) {
    // List model-facing params only, so the model is not invited to send a runtime-only field.
    const message = enrichInvalidInputMessage(
      binding.error.message,
      tool.modelInputSchema,
      binding.error.issues,
    );

    recordRejection({
      dispatch: args,
      outcome: "invalid_input",
      reason: message,
      issues: binding.error.issues,
      toolName,
    });

    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message,
        issues: binding.error.issues,
      },
    };
  }

  const { call } = binding;
  const input = call.input;
  const approvedResourceScope = workflowCapabilities[0]?.resourceScope;

  if (approvedResourceScope && !inputMatchesWorkflowResourceScope(input, approvedResourceScope)) {
    const message = `Tool '${toolName}' input is outside this workflow revision's approved resource boundary.`;
    recordRejection({ dispatch: args, outcome: "not_allowed", reason: message, toolName });

    return {
      kind: "not_allowed",
      result: { status: "capability_mismatch", toolName, integration, message },
    };
  }

  // Provider clients bind to this user's credentials, lazily.
  const ctx = toolExecuteContext({
    runId: args.runId,
    scratchpadRunId: args.scratchpadRunId ?? args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    userId: args.userId,
    timezone: args.timezone ?? (await settings({ userId: args.userId }).timezone()),
    caller,
    runContext: args.runContext,
    activeTools: args.activeTools,
    chat: args.chat,
    allowedIntegrations: args.allowedIntegrations,
    accountRef: workflowCapabilities[0]?.accountRef,
  });

  // A refusal that depends on the caller, which the schema cannot express. Its owner decides it.
  const refusal = call.refusal(ctx);

  if (refusal !== null) {
    recordRejection({
      dispatch: args,
      outcome: "invalid_input",
      reason: refusal,
      toolName,
      call,
    });

    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: refusal,
      },
    };
  }

  // `join` and `fast_path` skip only the approval gate; the checks above still ran.
  switch (tool.staging) {
    case "join":
      // ADR-0073: park on the child instead of making the boss poll.
      return await resolveAwaitSubAgentWithSpan(call, ctx);
    case "fast_path":
      return executeFastPath(call, ctx);
    case "question": {
      // ADR-0099: only the user fills `answers`. A fresh call with answers is the
      // model answering itself. Backstop: the model schema has no `answers` key.
      const question = questionToolInput.parse(input);

      if (question.answers !== undefined) {
        const message =
          `Tool '${toolName}' input must not include 'answers'. The user fills the answers on ` +
          "the question card; send only 'context' and 'questions'.";

        recordRejection({
          dispatch: args,
          outcome: "invalid_input",
          reason: message,
          toolName,
          call,
        });

        return {
          kind: "invalid_input",
          result: { status: "invalid_input", toolName, message },
        };
      }

      break;
    }

    case "staged":
      break;
    default: {
      // A new policy must not silently take the staged path.
      const unhandled: never = tool.staging;
      throw new Error(
        `[dispatch] unhandled staging policy '${String(unhandled)}' on '${toolName}'`,
      );
    }
  }

  // Only `staged` and `question` reach here, so the arm is non-null.
  const arm: GatedArmPolicy = STAGING_ARM[tool.staging];

  return continueWith({ ...resolved, call, ctx, arm });
};

/**
 * Stage 3: refuse before any write if the run was cancelled, an identical effect
 * is still `unknown`, or the user already settled this exact proposal.
 */
const suppressRepeatedStage: DispatchStage<ValidatedDispatch, SuppressedDispatch> = async (
  validated,
) => {
  const { args, toolName, arm, call, ctx } = validated;
  const input = call.input;

  const proposedInputHash = hashToolInput(toolName, input);

  // `cancelRunInTx` bumps the generation, so a newer one means the run was
  // cancelled mid-step. `executeAndCommit` reads it again before execute,
  // because the awaits below reopen the window.
  const fence = await stagingStore().readCancellationFence(args.runId);

  if (fence.generation > args.fence.generation) {
    return {
      kind: "fenced",
      stagingId: null,
      result: synthesizeCancelledByFence(),
    };
  }

  // Includes the target account, so the same args on another account are a different effect.
  const requestHash = hashToolRequest(toolName, input, ctx.accountRef);

  // An identical effect still `unknown` may have been delivered, so a repeat risks a duplicate.
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

  // The user already answered this exact proposal in this run (ADR-0034 scopes
  // the index per run). Replay the answer without a new row or notification.
  const priorReject = await stagingStore().findPriorRejection({
    runId: args.runId,
    toolName,
    proposedInputHash,
    statuses: arm.priorRejectionStatuses,
  });

  if (priorReject) {
    return settleWithoutExecution(arm, {
      dispatch: args,
      call,
      toolName,
      stagingId: null,
      input,
      status: priorReject.status === "expired" ? "expired" : "rejected",
      reason: priorReject.reason,
    });
  }

  return continueWith({ ...validated, proposedInputHash, requestHash });
};

/**
 * The chat thread's full-autonomy flag (ADR-0069 amendment). Read live, not from a run snapshot,
 * so a switch mid-turn applies to the next call. No thread means a background run: `false`.
 */
async function readFullAutonomy(args: ToolCallDispatchArgs): Promise<boolean> {
  if (args.approvalThreadId === undefined) return false;

  return stagingStore().readThreadFullAutonomy({
    userId: args.userId,
    threadId: args.approvalThreadId,
  });
}

/**
 * Stage 4: upsert the staging row, then act on its status. Pending parks or
 * executes, approved executes the decided input, and settled rows replay.
 */
const stageOrResumeStage: DispatchStage<SuppressedDispatch, never> = async (suppressed) => {
  const { args, tool, toolName, integration, call, ctx, arm, proposedInputHash, requestHash } =
    suppressed;

  const input = call.input;

  // The staging insert autocommits, so the executor cannot roll it back. Check
  // the run first. `null` means absent or unparseable.
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

  // Some tools resolve their tier from input (Calendar invites go up, `mcp.call` can go down).
  const riskTier = await resolveEffectiveRiskTier(call, ctx);
  const policyMode = await resolvePolicyMode(args.userId, toolName);
  const policyRequiresApproval = toolRequiresApproval(policyMode, riskTier);

  // Read only when a card would stage, so the normal path makes no read. Never waives a question.
  const fullAutonomy =
    !arm.forcesApproval && policyRequiresApproval && (await readFullAutonomy(args));

  const requiresApproval = arm.forcesApproval || (policyRequiresApproval && !fullAutonomy);

  if (fullAutonomy) {
    logger.info(
      { runId: args.runId, toolName, riskTier, threadId: args.approvalThreadId },
      "[dispatch] full autonomy waived the approval card",
    );
  }

  const approvalNotifyDelayMs = requiresApproval
    ? await resolveApprovalNotifyDelayMs(args.userId)
    : null;

  const notifyAfterAt =
    approvalNotifyDelayMs !== null ? new Date(Date.now() + approvalNotifyDelayMs) : null;

  // The `staging-expire` worker auto-rejects at this time, so an approval cannot park a run forever.
  const expiresAt = requiresApproval ? new Date(Date.now() + APPROVAL_EXPIRY_MS) : null;

  // A gated row keeps raw input, because resume executes it. An autonomous row stores it redacted.
  const redactedInput = call.redactedInput();
  const proposedInputForRow = !requiresApproval ? redactedInput : input;
  // Strict parse: resume executes this value, so a bad value must throw, not persist.
  const persistedProposedInput = jsonValueSchema.parse(proposedInputForRow);
  // Notifications read this column, never the raw `proposed_input`.
  const persistedDisplayInput = jsonValueSchema.parse(redactedInput);

  const upserted = await stagingStore().upsertStaging({
    userId: args.userId,
    runId: args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    toolName,
    integration,
    riskTier,
    proposedInput: persistedProposedInput,
    displayInput: persistedDisplayInput,
    proposedInputHash,
    requestHash,
    requiresApproval,
    status: "pending",
    notifyAfterAt,
    expiresAt,
  });

  let row = upserted.row;
  const insertedNew = upserted.wasInserted;

  // Two tools under one call id is a bug. Do not execute one against the other's row.
  if (row.toolName !== toolName) {
    throw new Error(
      `[dispatch] toolName mismatch on re-dispatch (run=${args.runId}, toolCallId=${args.toolCallId}, stored='${row.toolName}', got='${toolName}')`,
    );
  }

  let promotedPendingApproval = false;

  // Reclaim uses the complete live requirement, including policy for low/medium tools.
  // A pending row may gain a gate after a mode change, but it must never lose one.
  if (!insertedNew && row.status === "pending" && requiresApproval && !row.requiresApproval) {
    const promoted = await stagingStore().promotePendingApproval(row.id, {
      riskTier,
      proposedInput: persistedProposedInput,
      displayInput: persistedDisplayInput,
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
      // A pending row can gain a gate but never lose one (ADR-0034, ADR-0088).
      if (row.requiresApproval) {
        // Poke only when the row first enters the approvals queue.
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

        // Idempotent on the job id. The delay comes from the stored `expires_at`.
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

        // The only place the approval kind is written (ADR-0099).
        return {
          kind: "staged",
          stagingId: row.id,
          wake: {
            kind: "hil",
            approvalId: row.id,
            approvalKind: arm.approvalKind,
            prompt: arm.wakePrompt(toolName),
          },
        };
      }

      {
        const exhausted = await guardPassthroughBudget(row, tool, ctx);

        if (exhausted) return exhausted;
      }

      return executeAndCommit(row, call, ctx, {
        expectedFence: args.fence,
        editedByUser: false,
      });

    case "approved": {
      // Execute what the user approved from the row, never `args.input`, so a
      // re-dispatch cannot slip in an unapproved payload.
      const editedByUser = row.decidedInput !== null;
      const useInput = editedByUser ? row.decidedInput : row.proposedInput;
      // A user edit may break the schema. Fail the row instead of throwing.
      const rebound = tool.bind(useInput);

      if (!rebound.success) {
        const error = publicAppError("tool_input_invalid");
        await commitAndPoke(row, ctx, {
          status: "failed",
          outcome: "failed",
          error,
          executedAt: new Date(),
        });
        // No execution, so no span. Trace it here.
        recordRejection({
          dispatch: args,
          outcome: "failed",
          reason: error.message,
          issues: rebound.error.issues,
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

      return executeAndCommit(row, rebound.call, ctx, {
        expectedFence: args.fence,
        editedByUser,
        ...(editedByUser ? { executedInput: rebound.call.input } : {}),
      });
    }

    case "rejected":
    case "expired":
      return settleWithoutExecution(arm, {
        dispatch: args,
        call: storedCall(tool, row.proposedInput),
        toolName,
        stagingId: row.id,
        input: row.proposedInput,
        status: row.status,
        reason: row.rejectReason,
      });

    case "executed":
      // Replay the stored result. Keep the sanitize flag so the "may be incomplete" notice survives (ADR-0070 §1.1).
      return {
        kind: "executed",
        stagingId: row.id,
        toolResult: row.executeResult,
        editedByUser: row.decidedInput !== null,
        sanitized: row.executeSanitized,
        ...(row.decidedInput !== null ? { executedInput: row.decidedInput } : {}),
      };

    case "failed":
      return {
        kind: "failed",
        stagingId: row.id,
        error: extractStoredError(row.executeError),
        ...(row.decidedInput !== null ? { executedInput: row.decidedInput } : {}),
      };

    default: {
      // Fail instead of throwing, so the boss gets a tool result. The cases above are exhaustive,
      // so `row.status` is `never` here; `String` prints whatever an out-of-contract row holds.
      const diagnostic = `dispatcher saw unexpected staging status '${String(row.status)}'`;
      const error = publicAppError("tool_execution_failed");
      recordRejection({
        dispatch: args,
        outcome: "failed",
        reason: diagnostic,
        toolName,
        call: storedCall(tool, row.proposedInput),
      });

      return {
        kind: "failed",
        stagingId: row.id,
        error,
      };
    }
  }
};

/**
 * Resolve input-dependent risk. A downgrade needs a declared
 * `riskTierDowngradeReason`; otherwise it is clamped (ADR-0088).
 */
export async function resolveEffectiveRiskTier(
  call: BoundToolCall,
  ctx: ToolExecuteContext,
): Promise<ToolRiskTier> {
  const { tool } = call;

  if (!tool.resolvesRiskTier) return tool.riskTier;

  const resolved: unknown = await call.declaredRiskTier(ctx);

  // The resolver type is `Promise<ToolRiskTier>`, but nothing enforces that at
  // runtime, so a resolver can hand back a non-tier (ADR-0088). Fail closed to
  // the static tier. This checks only the resolver result, so the input is
  // still parsed one time.
  if (!isToolRiskTier(resolved)) {
    logger.warn(
      {
        event: "tool_risk_tier_invalid",
        toolName: tool.name,
        staticRiskTier: tool.riskTier,
        resolvedRiskTier: resolved,
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

const dispatchToolCallRoundAdapter: DispatchToolCallRoundAdapter = {
  dispatch: dispatchToolCall,
  wouldWaitForApproval: toolCallWouldGate,
  executionLane(toolName) {
    if (!isToolName(toolName)) return null;

    return getTool(toolName)?.executionLane ?? null;
  },
  artifactStreamMode(toolName) {
    if (!isToolName(toolName)) return null;

    return getTool(toolName)?.artifactStream ?? null;
  },
};

/** Install the dispatcher as the call-round adapter at boot. */
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

  // With no exact name, the search top hit can be a write the model did not
  // mean, so the hint tells it to choose by intent.
  const loadHint = suggestion.toolName
    ? `Call system.load_tool with name '${suggestion.toolName}' first,`
    : `Call system.search_tools for '${suggestion.integration}', then call the candidate that matches your intent by its exact name. The search loads its top registered hit, and any other candidate loads when you first call it.`;

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

  // A bare slug (`calendar`): the action was in the rejected args, so list the integration's actions.
  if (isIntegrationSlug(input) && input !== "system") {
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(input)) {
      return null;
    }

    // No actions: a hint would loop the boss through discovery for nothing.
    if (INTEGRATION_ACTIONS[input].length === 0) return null;

    return {
      integration: input,
      toolName: null,
      validActions: INTEGRATION_ACTIONS[input],
      inputWasQualified: false,
    };
  }

  const matches = INTEGRATION_SLUGS.filter((integration) => {
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
 * Tokens that mean "list many". Token overlap alone would send
 * `list_pull_requests` to `get_pull_request`; `search` is the right hint.
 */
const ENUMERATION_TOKENS = new Set(["list", "find", "all", "search"]);

function closestAction(input: string, actions: readonly string[]): string | null {
  if (actions.length === 0) return null;

  if (actions.includes(input)) return input;

  if (actions.length === 1) return actions[0] ?? null;

  const inputTokens = actionTokens(input);

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
 * Run a tool inside a `tool:<name>` Langfuse span. I/O is recorded only when
 * `LANGFUSE_CAPTURE_IO` is on. Errors close the span and rethrow.
 */
async function executeToolWithSpan(
  call: BoundToolCall,
  ctx: ToolExecuteContext,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- a tool's `execute` result is free-form JSON; the callers sanitize it into a `JsonValue`.
): Promise<unknown> {
  const { tool } = call;

  const span = toolSpanStarter({
    runId: ctx.runId,
    toolName: tool.name,
    toolCallId: ctx.toolCallId,
    userId: ctx.userId,
    caller: callerLabel(ctx.caller),
    stepId: ctx.stepId,
    // Always redacted: a span is never a resume payload.
    input: call.redactedInput(),
    startedAt: new Date(),
  });

  try {
    const result = await call.execute(ctx);
    // ADR-0074: record passthrough truncation in span metadata, which is kept even with I/O capture off.
    const thermometer = passthroughTruncationTelemetry(tool.name, ctx.runId, result);

    if (thermometer) {
      logger.info(
        { event: "passthrough_truncation", ...thermometer },
        "Passthrough result truncated",
      );
      span.success(result, { thermometer: toJsonValue(thermometer) });
    } else {
      span.success(result);
    }

    return result;
  } catch (err) {
    span.error(safeErrorDiagnostic(err));
    throw err;
  }
}

async function resolveAwaitSubAgentWithSpan(
  call: BoundToolCall,
  ctx: ToolExecuteContext,
): Promise<DispatchResult> {
  const { tool } = call;
  // `registerTool` probes that a join tool's parsed input carries this contract. Parse before
  // the span opens, so a bad input cannot leave a span open.
  const { childRunId } = joinToolInput.parse(call.input);

  const span = toolSpanStarter({
    runId: ctx.runId,
    toolName: tool.name,
    toolCallId: ctx.toolCallId,
    userId: ctx.userId,
    caller: callerLabel(ctx.caller),
    stepId: ctx.stepId,
    input: call.redactedInput(),
    startedAt: new Date(),
  });

  try {
    const result = await resolveAwaitSubAgent({
      parentRunId: ctx.runId,
      userId: ctx.userId,
      childRunId,
    });

    span.success(awaitSubAgentSpanOutput(result));

    return result.kind === "executed" ? { ...result, joinedChildRunId: childRunId } : result;
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
    case "blocked":
    case "feature_disabled":
    case "fenced":
    case "inactive_tool":
    case "invalid_input":
    case "not_allowed":
    case "rejected":
    case "staged":
    case "unanswered":
    case "unknown_tool":
      return { status: result.kind };
    default: {
      const _exhaustive: never = result;

      return _exhaustive;
    }
  }
}

/**
 * ADR-0074 per-run passthrough ceiling. Over it, commit a visible
 * `budget_exhausted` result instead of executing, so the boss stops paging.
 * Returns `null` when the call may run.
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
  // Minted here, not by the tool, so there is nothing to sanitize.
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
 * Commit a terminal staging write, then poke. A poke before the commit shows a
 * stale row. Autonomous rows are never in the approvals queue, so no poke.
 */
async function commitAndPoke(
  row: StagingRow,
  ctx: ToolExecuteContext,
  commit: StagingCommit,
): Promise<void> {
  const committed = await stagingStore().commitStaging(
    row.id,
    { status: row.status, outcome: row.outcome },
    commit,
  );

  if (committed && row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
}

async function executeAndCommit(
  row: StagingRow,
  call: BoundToolCall,
  ctx: ToolExecuteContext,
  opts: { expectedFence: CancellationFence; editedByUser: boolean; executedInput?: unknown },
): Promise<DispatchResult> {
  // Second fence read, for a cancel that landed during dispatch. The row exists
  // now, so close it instead of leaving it pending.
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
    // The MCP broker mints its ledger row 1:1 with this staging row.
    result = await executeToolWithSpan(call, { ...ctx, stagingId: row.id });
  } catch (err) {
    // ADR-0070 §1.3: map to a public error, so raw exception text never persists.
    error = toPublicAppError(err);
    logger.error(
      { err, event: "tool_execution_failed", toolName: call.tool.name, runId: ctx.runId },
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

    return {
      kind: "failed",
      stagingId: row.id,
      error,
      ...(opts.executedInput !== undefined ? { executedInput: opts.executedInput } : {}),
    };
  }

  // ADR-0070 §1.1: sanitize before the value reaches the row or the transcript.
  const sanitizedResult = sanitizeToolResult(result);
  const persistedResult = toJsonValue(sanitizedResult.value);
  const didSanitize = sanitizedResult.removed > 0 || sanitizedResult.collisions > 0;

  if (didSanitize) {
    logger.warn(
      `[dispatch] sanitized ${sanitizedResult.removed} poison code unit(s)` +
        `${sanitizedResult.collisions > 0 ? `, ${sanitizedResult.collisions} key collision(s)` : ""}` +
        ` from ${call.tool.name} result`,
    );
  }

  // Possibly delivered without confirmation, so the repeat barrier must see `unknown`.
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
    ...(opts.executedInput !== undefined ? { executedInput: opts.executedInput } : {}),
  };
}

async function executeFastPath(
  call: BoundToolCall,
  ctx: ToolExecuteContext,
): Promise<DispatchResult> {
  const { tool } = call;

  try {
    const result = await executeToolWithSpan(call, ctx);
    // ADR-0070 §1.1: the fast path result also reaches the transcript.
    const sanitized = sanitizeToolResult(result);
    const jsonResult = toJsonValue(sanitized.value);
    const didSanitize = sanitized.removed > 0 || sanitized.collisions > 0;

    if (didSanitize) {
      logger.warn(
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
    // ADR-0070 §1.3: raw exception text never reaches the model.
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

/** Refusal for a call whose identical effect is still `unknown`. Same shape the MCP broker returns. */
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

function synthesizeRejection(args: SynthesizeRejectionArgs): RejectedToolResult {
  return {
    status: "rejected_by_user",
    toolName: args.toolName,
    proposedInput: args.proposedInput,
    reason: args.reason,
    retryPolicy: "do_not_retry_identical",
  };
}

/**
 * Result for a rejected or expired row. A write reads as a rejection, a
 * question as `unanswered` (ADR-0099).
 */
function settleWithoutExecution(
  arm: GatedArmPolicy,
  args: {
    dispatch: ToolCallDispatchArgs;
    /** The trace's input. `undefined` when a stored input no longer parses. */
    call: BoundToolCall | undefined;
    toolName: ToolName;
    stagingId: string | null;
    /** The input that the user rejected, as it was proposed. */
    input: unknown;
    status: PriorRejectionStatus;
    reason: string | null;
  },
): DispatchResult {
  const reason =
    args.status === "expired" ? "auto-expired" : (args.reason ?? arm.rejectedWithoutReason);

  recordRejection({
    dispatch: args.dispatch,
    outcome: "rejected",
    reason,
    toolName: args.toolName,
    call: args.call,
  });

  if (arm.settled === "unanswered") {
    return {
      kind: "unanswered",
      stagingId: args.stagingId,
      result: synthesizeUnansweredQuestions({
        toolName: args.toolName,
        input: args.input,
        reason: args.status === "expired" ? "expired" : "dismissed",
      }),
    };
  }

  return {
    kind: "rejected",
    stagingId: args.stagingId,
    result: synthesizeRejection({
      toolName: args.toolName,
      proposedInput: args.input,
      reason,
    }),
  };
}

/**
 * Result for a dismissed or expired question card (ADR-0099). Retry suppression
 * blocks an identical repeat; the message stops a reworded one.
 */
function synthesizeUnansweredQuestions(args: {
  toolName: ToolName;
  input: unknown;
  reason: Exclude<AskUserUnansweredReason, "no_answers">;
}): UnansweredQuestionsToolResult {
  const parsed = questionToolInput.safeParse(args.input);
  const questions = parsed.success ? parsed.data.questions : [];

  const what =
    args.reason === "expired"
      ? "The user did not answer these questions before the card expired."
      : "The user dismissed these questions without answering.";

  return {
    status: "unanswered",
    toolName: args.toolName,
    reason: args.reason,
    questions,
    message:
      `${what} Do not ask them again, in these words or in others. Continue the task on a ` +
      "reasonable assumption, state that assumption to the user in one sentence, and invite a " +
      "correction.",
    retryPolicy: "do_not_retry_identical",
  };
}

/**
 * Bind a stored `proposed_input` for the trace only. A row written before a schema change may no
 * longer parse; then the trace keeps no input, because only a parsed input has a redaction path.
 */
function storedCall(tool: RegisteredTool, stored: unknown): BoundToolCall | undefined {
  const binding = tool.bind(stored);

  return binding.success ? binding.call : undefined;
}

function extractStoredError(stored: unknown): PublicAppError {
  // Old rows may hold raw exception text, so re-render from the catalog.
  return publicAppErrorFromStored(stored);
}
