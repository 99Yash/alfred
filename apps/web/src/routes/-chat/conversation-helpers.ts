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
 * Show the bare spinner while running with nothing visible yet.
 * The group header (not this spinner) names a hidden plumbing step once one has run.
 * Check `done`: the live bubble stays mounted until sync, so a turn stopped early would spin when finished.
 * Ignores `narration`: closed prose is not live activity.
 * Requires no reasoning: `ReasoningSection` already shows "Thinking" for the whole tool phase.
 */
export function shouldShowThinkingIndicator(stream: StreamingMessage): boolean {
  if (stream.done || stream.text.length > 0 || stream.compacting || stream.awaitingCapacity) {
    return false;
  }

  return (
    visibleTools(stream.tools).length === 0 &&
    stream.reasoning.length === 0 &&
    !stream.reasoningActive
  );
}

/** Label for the floating activity pill: the running tool's verb, else writing, else thinking. */
export function describeActivity(stream: StreamingMessage): string {
  if (stream.compacting) return "Condensing conversation…";

  if (stream.awaitingCapacity) return "Waiting for model capacity…";
  // A hidden running step falls through to the writing/thinking label.
  const lastTool = visibleTools(stream.tools).at(-1);

  if (lastTool && lastTool.status === "started") return `${presentTool(lastTool).running}…`;

  if (stream.text.length > 0) return "Responding…";

  if (stream.reasoningActive) return "Thinking…";

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
