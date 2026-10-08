import {
  boundToolResult,
  getStringPath,
  isRecord,
  toJsonValue,
  type AgentTranscriptMessage,
  type ChatConnectNudge,
  type ToolUnavailabilityCode,
} from "@alfred/contracts";

import type { CompletedToolCall, ProposedToolCall } from "../index";
import type { ToolCallDispatchResult } from "./adapter";

export type TerminalToolCallDispatchResult = Exclude<
  ToolCallDispatchResult,
  { kind: "staged" | "parked" }
>;

export function toolResultMessage(
  call: ProposedToolCall,
  result: TerminalToolCallDispatchResult,
): AgentTranscriptMessage {
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
): { type: "json"; value: unknown } | { type: "error-json"; value: unknown } {
  switch (result.kind) {
    case "executed":
      return {
        type: "json",
        value: toJsonValue({
          status: "executed",
          result: boundToolResult(result.toolResult).value,
          editedByUser: result.editedByUser,
          ...(result.sanitized
            ? {
                sanitized: true,
                notice:
                  "Non-text bytes were stripped from this result before storage; it may be incomplete.",
              }
            : {}),
        }),
      };
    case "failed":
      return {
        type: "error-json",
        value: toJsonValue(boundToolResult({ status: "failed", error: result.error }).value),
      };
    case "rejected":
    case "unanswered":
    case "blocked":
    case "fenced":
    case "invalid_input":
    case "unknown_tool":
    case "inactive_tool":
    case "not_allowed":
    case "feature_disabled":
      return { type: "json", value: toJsonValue(boundToolResult(result.result).value) };
  }
}

const SIDE_EFFECT_ACTION_TOKENS = new Set([
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "cancel",
  "close",
  "create",
  "delete",
  "deploy",
  "dismiss",
  "edit",
  "forget",
  "forward",
  "insert",
  "invite",
  "label",
  "merge",
  "move",
  "post",
  "promote",
  "publish",
  "reject",
  "remember",
  "remove",
  "reopen",
  "reply",
  "redeploy",
  "resolve",
  "reschedule",
  "save",
  "schedule",
  "send",
  "set",
  "snooze",
  "spawn",
  "suggest",
  "tag",
  "unarchive",
  "unassign",
  "unlabel",
  "untag",
  "update",
  "upload",
  "write",
]);

function actionTokensForToolName(toolName: string): string[] {
  const rawAction = toolName.includes(".")
    ? toolName.slice(toolName.lastIndexOf(".") + 1)
    : toolName;

  return rawAction
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function isMutatingToolName(toolName: string): boolean {
  return actionTokensForToolName(toolName).some((token) => SIDE_EFFECT_ACTION_TOKENS.has(token));
}

const INCOMPLETE_ACTION_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "invalid",
  "invalid_input",
  "needs_clarification",
  "no_thread",
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

export function toolCallLogStatus(
  toolName: string,
  result: TerminalToolCallDispatchResult,
): "succeeded" | "failed" {
  // ADR-0099: an unanswered question is settled, not failed.
  if (result.kind === "unanswered") return "succeeded";

  if (result.kind !== "executed") return "failed";

  if (isMutatingToolName(toolName) && executedResultIsIncomplete(result.toolResult)) {
    return "failed";
  }

  return "succeeded";
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
    default:
      return undefined;
  }
}
