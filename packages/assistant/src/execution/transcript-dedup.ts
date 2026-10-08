import { getStringPath, type AgentTranscriptMessage } from "@alfred/contracts";

/**
 * On invalid tool input the SDK adds its own tool result. The dispatcher writes the real one,
 * and two results for one call make Anthropic return a 400. True only if every part is for this
 * turn's calls.
 */
export function isSynthesizedToolDup(
  message: AgentTranscriptMessage,
  stepCallIds: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool") return false;

  if (!Array.isArray(message.content) || message.content.length === 0) return false;

  return message.content.every((part) => {
    const id = getStringPath(part, "toolCallId");

    return id !== undefined && stepCallIds.has(id);
  });
}

/** Append the turn's messages without {@link isSynthesizedToolDup} duplicates. */
export function appendModelResponseMessages(
  transcript: readonly AgentTranscriptMessage[],
  messages: readonly AgentTranscriptMessage[],
  stepCallIds: ReadonlySet<string>,
): AgentTranscriptMessage[] {
  return [...transcript, ...messages.filter((m) => !isSynthesizedToolDup(m, stepCallIds))];
}
