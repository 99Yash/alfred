import type { SyncedActionStaging, SyncedChatMessage } from "@alfred/sync";
import { asQuestionStaging } from "~/components/approvals/ask-user";
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
 * Label for the floating activity pill: the running tool's verb, else the document the run
 * writes, else responding, else thinking.
 */
export function describeActivity(stream: StreamingMessage, writingLabel: string | null): string {
  if (stream.compacting) return "Condensing conversation…";

  if (stream.awaitingCapacity) return "Waiting for model capacity…";
  // A hidden running step falls through to the writing/thinking label.
  const lastTool = visibleTools(stream.tools).at(-1);

  if (lastTool && lastTool.status === "started") return `${presentTool(lastTool).running}…`;

  if (writingLabel) return `${writingLabel}…`;

  if (stream.text.length > 0) return "Responding…";

  if (stream.reasoningActive || shouldShowThinkingIndicator(stream, false)) return "Thinking…";

  return "Working…";
}

/**
 * Label for the pill when a pending card is off-screen, or `null` with none pending.
 * A question is not an approval (ADR-0099), so a lone question gets its own verb.
 */
export function reviewLabel(approvals: readonly SyncedActionStaging[]): string | null {
  const [first] = approvals;

  if (!first) return null;

  if (approvals.length > 1) return `Review ${approvals.length} actions`;

  return asQuestionStaging(first) ? "Answer question" : "Review action";
}

/** The model-written next prompts on the last reply (ADR-0112), once it is complete. */
export function buildFollowUpSuggestions(
  messages: readonly SyncedChatMessage[],
): FollowUpSuggestion[] {
  const last = messages[messages.length - 1];

  if (!last || last.role !== "assistant" || last.status !== "complete") return [];

  return (last.followUps ?? []).map((text, index) => ({ id: `${last.id}:${index}`, text }));
}
