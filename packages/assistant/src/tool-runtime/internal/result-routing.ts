import type { TranscriptMessage } from "@alfred/ai";
import {
  assertNever,
  boundForModel,
  CODE_RUN_TOOL,
  getStringPath,
  isActionTool,
  isJsonObject,
  isRecord,
  isUnknownEffectEnvelope,
  toJsonValue,
  type ChatConnectNudge,
  type JsonValue,
  type ResultTruncation,
  type ToolUnavailabilityCode,
} from "@alfred/contracts";

import type { CompletedToolCall, ProposedToolCall } from "../index";
import type { PublicAppError } from "@alfred/contracts/app-errors";
import type { CardOutcome, RejectedToolResult, ToolCallDispatchResult } from "./adapter";
import { NO_TOOL_EFFECTS } from "./registry";
import { approvalCauseFact, type ApprovalCauseFact } from "../approval-rule";
import type { ToolResultPart } from "ai";

export type TerminalToolCallDispatchResult = Exclude<
  ToolCallDispatchResult,
  { kind: "staged" | "parked" }
>;

export function toolResultMessage(
  call: ProposedToolCall,
  result: TerminalToolCallDispatchResult,
): TranscriptMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: dispatchResultToToolOutput(result),
      },
    ],
  };
}

function dispatchResultToToolOutput(
  result: TerminalToolCallDispatchResult,
): Extract<ToolResultPart["output"], { type: "json" | "error-json" }> {
  switch (result.kind) {
    case "executed":
      return {
        type: "json",
        value: toJsonValue({
          status: "executed",
          ...boundedResultFields(result.toolResult),
          editedByUser: result.editedByUser,
          ...(result.sanitized
            ? {
                sanitized: true,
                notice:
                  "Non-text bytes were stripped from this result before storage; it may be incomplete.",
              }
            : {}),
          ...approvalCauseField(result),
        }),
      };
    case "failed":
      return {
        type: "error-json",
        value: boundedWithApprovalCause({ status: "failed", error: result.error }, result),
      };
    case "rejected":
      return {
        type: "json",
        value: boundedWithApprovalCause(result.result, result),
      };
    case "unanswered":
    case "blocked":
    case "fenced":
    case "invalid_input":
    case "unknown_tool":
    case "inactive_tool":
    case "not_allowed":
    case "feature_disabled":
      return { type: "json", value: boundedEnvelope(result.result) };
    default:
      return assertNever(result, "tool call dispatch result");
  }
}

/** A card's cause and its settings, for the model to name (ADR-0130 decision 4). */
function approvalCauseField(result: CardOutcome): { approvalCause?: ApprovalCauseFact } {
  return result.approvalCause ? { approvalCause: approvalCauseFact(result.approvalCause) } : {};
}

/** The model envelope of a card result that is not `executed`. */
type CardEnvelope = RejectedToolResult | { status: "failed"; error: PublicAppError };

/** The bounded envelope with the cause beside its fields. An envelope is always a record. */
function boundedWithApprovalCause(envelope: CardEnvelope, result: CardOutcome): JsonValue {
  const bounded = boundedEnvelope(envelope);

  if (!result.approvalCause || !isJsonObject(bounded)) return bounded;

  return toJsonValue({ ...bounded, ...approvalCauseField(result) });
}

/**
 * The tool result under the one size rule (ADR-0130 decision 5), with its truncation note beside it.
 * The staging row keeps the whole result; only the model's copy is bounded.
 */
function boundedResultFields(toolResult: unknown): {
  result: JsonValue;
  truncation?: ResultTruncation;
} {
  const bounded = boundForModel(toJsonValue(toolResult));

  return bounded.truncation
    ? { result: bounded.value, truncation: bounded.truncation }
    : { result: bounded.value };
}

/** An envelope under the one size rule. A cut record carries its note as a field. */
function boundedEnvelope(envelope: unknown): JsonValue {
  const bounded = boundForModel(toJsonValue(envelope));

  if (!bounded.truncation || !isJsonObject(bounded.value)) return bounded.value;

  return toJsonValue({ ...bounded.value, truncation: bounded.truncation });
}

const INCOMPLETE_ACTION_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "invalid",
  "invalid_input",
  "needs_clarification",
  "not_allowed",
  "not_found",
  "page_limit",
  "rejected",
  "rejected_by_user",
  // A possibly-delivered write logs as failed, never as a quiet success.
  "unknown",
  "unknown_tool",
  "wrong_kind",
]);

function executedResultIsIncomplete(value: unknown): boolean {
  if (!isRecord(value)) return false;

  if (value.ok === false || value.success === false) return true;
  const status = getStringPath(value, "status");

  return status !== undefined && INCOMPLETE_ACTION_STATUSES.has(status);
}

/**
 * The outcome of one executed attempt, from its returned result. The action record, the trace
 * span, and the chat trail all read it, so they report the same facts.
 * `unknown`: the write may have landed, and nothing confirmed it.
 */
export function executedResultOutcome(
  toolName: string,
  value: unknown,
): "succeeded" | "failed" | "unknown" {
  if (isUnknownEffectEnvelope(value)) return "unknown";

  // A script that did not complete returned its failure as a value (ADR-0124). Read failures
  // inside a completed script stay in its `reads` counts.
  if (toolName === CODE_RUN_TOOL) {
    return getStringPath(value, "status") === "completed" ? "succeeded" : "failed";
  }

  return isActionTool(toolName) && executedResultIsIncomplete(value) ? "failed" : "succeeded";
}

export function toolCallLogStatus(
  toolName: string,
  result: TerminalToolCallDispatchResult,
): "succeeded" | "failed" {
  // ADR-0099: an unanswered question is settled, not failed.
  if (result.kind === "unanswered") return "succeeded";

  if (result.kind !== "executed") return "failed";

  // A possibly-delivered write logs as failed, never as a quiet success.
  return executedResultOutcome(toolName, result.toolResult) === "succeeded"
    ? "succeeded"
    : "failed";
}

export function isNonExecutionFailure(result: TerminalToolCallDispatchResult): boolean {
  return (
    result.kind === "invalid_input" ||
    result.kind === "unknown_tool" ||
    result.kind === "inactive_tool" ||
    result.kind === "not_allowed" ||
    result.kind === "feature_disabled"
  );
}

export function completedToolCall<Call extends ProposedToolCall>(
  call: Call,
  result: TerminalToolCallDispatchResult,
): CompletedToolCall<Call> {
  const status = toolCallLogStatus(call.toolName, result);

  const value =
    result.kind === "executed"
      ? result.toolResult
      : result.kind === "failed"
        ? result.error
        : result.result;

  return {
    call,
    result: value,
    status,
    execution:
      result.kind === "executed" || result.kind === "unanswered"
        ? "completed"
        : result.kind === "failed" ||
            result.kind === "rejected" ||
            result.kind === "blocked" ||
            result.kind === "fenced"
          ? "failed"
          : "not_reached",
    sanitized: result.kind === "executed" && result.sanitized === true,
    nonExecution: status === "failed" && isNonExecutionFailure(result),
    connectNudge: connectNudgeFromDispatch(result),
    approvalCause:
      result.kind === "executed" || result.kind === "failed" || result.kind === "rejected"
        ? result.approvalCause
        : undefined,
    executedInput:
      result.kind === "executed" || result.kind === "failed" ? result.executedInput : undefined,
    joinedChildRunId: result.kind === "executed" ? result.joinedChildRunId : undefined,
    verifiedRead: result.kind === "invalid_input" ? result.verifiedRead : undefined,
    effects: result.kind === "executed" ? result.effects : NO_TOOL_EFFECTS,
  };
}

/** Maps a connection-health refusal to its repair. Policy refusals get no nudge. */
function connectNudgeFromDispatch(
  result: TerminalToolCallDispatchResult,
): ChatConnectNudge | undefined {
  if (result.kind !== "not_allowed" || result.unavailability === undefined) return undefined;
  const action = connectActionFor(result.unavailability);

  if (action === undefined) return undefined;

  return { integration: result.result.integration, action };
}

function connectActionFor(code: ToolUnavailabilityCode): ChatConnectNudge["action"] | undefined {
  switch (code) {
    case "not_connected":
      return "connect";
    case "needs_reauth":
    case "missing_scope":
      // A credential exists but cannot act. Reconnecting repairs both.
      return "reconnect";
    // Connecting does not repair these; the chat shows no nudge.
    case "feature_disabled":
    case "not_allowed":
    case "requires_thread":
    case "wrong_caller":
      return undefined;
    default:
      return assertNever(code, "tool unavailability code");
  }
}
