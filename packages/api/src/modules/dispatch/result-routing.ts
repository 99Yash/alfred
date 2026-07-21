import { boundToolResult, isRecord, toJsonValue, type AgentTranscriptMessage } from "@alfred/contracts";
import type { DispatchResult } from "./index";

/**
 * The subset of a pending tool call the transcript renderer needs — the shared
 * `PendingToolCall` core (chat extends it with a narration `segmentIndex`; the
 * brief uses the core as-is), narrowed to what a tool-result message reads.
 */
interface DispatchedToolCall {
  toolCallId: string;
  toolName: string;
}

/** Everything a dispatch loop renders/classifies — the terminal results, never
 *  the two `interrupt`-shaped ones (`staged`/`parked`), which the loop turns
 *  into a `StepResult.interrupt` before reaching here. */
export type TerminalDispatchResult = Exclude<DispatchResult, { kind: "staged" | "parked" }>;

/**
 * A dispatched tool result rendered as the `tool` transcript message the model
 * reads on the next step. Shared by the interactive chat turn and the sub-agent
 * brief so the two paths can never drift on how a result is surfaced.
 */
export function toolResultMessage(
  call: DispatchedToolCall,
  result: TerminalDispatchResult,
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
  result: TerminalDispatchResult,
): { type: "json"; value: unknown } | { type: "error-json"; value: unknown } {
  switch (result.kind) {
    case "executed":
      return {
        type: "json",
        value: toJsonValue({
          status: "executed",
          // Guardrail: clip only pathologically-long free-text fields before
          // they hit the replayed transcript (see boundToolResult); normal
          // single-object reads and navigational fields pass through untouched.
          result: boundToolResult(result.toolResult).value,
          // Surface that the user edited the proposed input before approving, so
          // the model can account for the correction in future suggestions (the
          // `editedByUser` field on the executed envelope documents this intent).
          editedByUser: result.editedByUser,
          // ADR-0070: surface to the model that this result had non-text bytes
          // stripped before storage, so it doesn't treat a silently-mutated
          // (binary-ish) payload as pristine.
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
    case "invalid_input":
    case "unknown_tool":
    case "inactive_tool":
    case "not_allowed":
    // A background brief has no narration channel to protect (unlike chat, where
    // `feature_disabled` is hidden as internal plumbing on the UI/log channel),
    // so on the transcript these non-execution reasons are surfaced to the agent
    // as a plain tool result on purpose — it can then route around the
    // disabled/unavailable tool. Intentional, not a missed case.
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
  const snakeish = rawAction.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return snakeish
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function looksSideEffectingToolName(toolName: string): boolean {
  return actionTokensForToolName(toolName).some((token) => SIDE_EFFECT_ACTION_TOKENS.has(token));
}

export function isMutatingToolName(toolName: string): boolean {
  // Approval risk is not mutability: several sensitive reads are `low`, while
  // user-visible in-app writes (`system.create_artifact`, `system.suggest_todo`)
  // are `no_risk` because they never need HIL. Classify by the action verb
  // instead so the honesty guard tracks whether a user-visible action completed.
  return looksSideEffectingToolName(toolName);
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
  "unknown_tool",
  "wrong_kind",
]);

function executedResultIsIncomplete(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ok === false || value.success === false) return true;
  return typeof value.status === "string" && INCOMPLETE_ACTION_STATUSES.has(value.status);
}

export function toolCallLogStatus(
  toolName: string,
  result: TerminalDispatchResult,
): "succeeded" | "failed" {
  if (result.kind !== "executed") return "failed";
  if (isMutatingToolName(toolName) && executedResultIsIncomplete(result.toolResult)) {
    return "failed";
  }
  return "succeeded";
}

/**
 * A dispatch failure rejected before execution: malformed, invented, inactive,
 * or disallowed. The model self-corrects these on the next step, and the prompt
 * already says not to narrate internal retries, so they are NOT "an action
 * attempt that didn't complete" and the
 * #346 honesty guard must skip them. Counting them made a self-corrected first
 * attempt (e.g. `gmail.send_draft` with `to` as a string) force a misleading
 * regenerate that claimed the *later, approved, executed* send had failed.
 * `failed` (a real execution fault, possibly partial) and `rejected` (the user
 * declined) DID reach/affect the side-effect path, so they still trip the guard.
 */
export function isNonExecutionFailure(result: TerminalDispatchResult): boolean {
  return (
    result.kind === "invalid_input" ||
    result.kind === "unknown_tool" ||
    result.kind === "inactive_tool" ||
    result.kind === "not_allowed" ||
    // ADR-0074: the user turned this passthrough tier off. Never reached the
    // side-effect path and the model must not narrate a disabled capability, so
    // it is hidden `nonExecution` plumbing (the opposite of a visible gate
    // `rejected`, which rides `kind:"executed"`).
    result.kind === "feature_disabled"
  );
}

/**
 * Whether a completed dispatch round auto-activated ≥1 tool via an inactive-tool
 * bounce (#407) — the signal that the NEXT chat-turn is an internal reissue. Only
 * `inactive_tool` counts: it's the round that made a fresh schema available and
 * asks the model to reissue, producing the "tools warming up, retrying" lead-in.
 * The other non-execution rejections (`invalid_input`, `unknown_tool`,
 * `not_allowed`) don't auto-activate anything, so they don't mark a reissue turn.
 */
export function dispatchRoundReissued(results: readonly (DispatchResult | undefined)[]): boolean {
  return results.some((result) => result?.kind === "inactive_tool");
}
