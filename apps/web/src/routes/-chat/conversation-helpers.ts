import type { SyncedActionStaging, SyncedChatMessage } from "@alfred/sync";
import type { StreamingMessage } from "~/lib/chat/chat-stream-state";
import { presentTool, visibleTools } from "./tool-call-presentation";

export interface FollowUpSuggestion {
  id: string;
  text: string;
}

export function shouldShowStream(
  messages: readonly SyncedChatMessage[],
  stream: StreamingMessage | null,
): stream is StreamingMessage {
  return stream !== null && !messages.some((m) => m.id === stream.messageId);
}

/**
 * Show "Thinking" at the end of the trail while a model step runs with nothing else live:
 * before the first frame, and again between tools in each later step.
 * Check `done`: the live bubble stays mounted until sync, so a turn stopped early would spin when finished.
 * Ignores `narration`: closed prose is not live activity.
 * Not while `reasoningActive`: the top `ReasoningSection` shows the first step's "Thinking".
 * Not while a visible tool runs: its card shows the work. A hidden plumbing call shows nothing, so it still counts.
 * While the run writes a document, show it under the step's text too: the text is a lead-in
 * whose tool card arrives only when the body is complete.
 */
export function shouldShowThinkingIndicator(stream: StreamingMessage, writing: boolean): boolean {
  if (
    stream.done ||
    (stream.text.length > 0 && !writing) ||
    stream.compacting ||
    stream.awaitingCapacity ||
    stream.awaitingApproval ||
    stream.reasoningActive
  ) {
    return false;
  }

  return !visibleTools(stream.tools).some((tool) => tool.status === "started");
}

/**
 * When the live model step started, for the "Thinking" clock: the turn start, or the end of
 * the last tool call, because the next step starts when the tools return.
 */
export function modelStepStartedTs(stream: StreamingMessage): number {
  let startedTs = stream.turnStartedTs;

  for (const tool of stream.tools) {
    if (tool.endedTs !== null && tool.endedTs > startedTs) startedTs = tool.endedTs;
  }

  return startedTs;
}

/** The live step's label while the run writes a document body into the side panel. */
export function describeWriting(title: string | null): string {
  return title ? `Writing “${title}”` : "Writing the document";
}

/**
 * Label for the floating activity pill: what the run waits on, else the latest running tool's
 * verb, else the document the run writes, else responding, else thinking.
 * Check the wait first, so a parked run never reads as a running tool.
 */
export function describeActivity(
  stream: StreamingMessage,
  writingLabel: string | null,
  approvalWait: string | null,
): string {
  if (stream.compacting) return "Condensing conversation…";

  if (stream.awaitingCapacity) return "Waiting for model capacity…";

  if (approvalWait) return approvalWait;
  // Parallel calls can settle out of order, so take the latest one still running, not the last one.
  // A hidden running step falls through to the writing/thinking label.
  const runningTool = visibleTools(stream.tools).findLast((tool) => tool.status === "started");

  if (runningTool) return `${presentTool(runningTool).running}…`;

  if (writingLabel) return `${writingLabel}…`;

  if (stream.text.length > 0) return "Responding…";

  if (stream.reasoningActive || shouldShowThinkingIndicator(stream, false)) return "Thinking…";

  return "Working…";
}

/** The model-written next prompts on the last reply (ADR-0112), once it is complete. */
export function buildFollowUpSuggestions(
  messages: readonly SyncedChatMessage[],
): FollowUpSuggestion[] {
  const last = messages[messages.length - 1];

  if (!last || last.role !== "assistant" || last.status !== "complete") return [];

  return (last.followUps ?? []).map((text, index) => ({ id: `${last.id}:${index}`, text }));
}

/** Sort approvals in tool-trail order. Ones with no tool card go last, by `createdAt`. */
export function orderApprovalsByTool(
  approvals: readonly SyncedActionStaging[],
  stream: StreamingMessage | null,
): readonly SyncedActionStaging[] {
  if (approvals.length <= 1) return approvals;
  const toolOrder = new Map<string, number>();
  stream?.tools.forEach((tool, i) => toolOrder.set(tool.toolCallId, i));

  return approvals.toSorted((a, b) => {
    const ia = toolOrder.get(a.toolCallId) ?? Number.POSITIVE_INFINITY;
    const ib = toolOrder.get(b.toolCallId) ?? Number.POSITIVE_INFINITY;

    if (ia !== ib) return ia - ib;

    return a.createdAt.localeCompare(b.createdAt);
  });
}
