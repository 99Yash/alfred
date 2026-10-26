import type { TranscriptMessage } from "@alfred/ai";

/**
 * On invalid tool input the SDK adds its own tool result. The dispatcher writes the real one,
 * and two results for one call make Anthropic return a 400. True only if every part is for this
 * turn's calls.
 */
export function isSynthesizedToolDup(
  message: TranscriptMessage,
  stepCallIds: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool") return false;

  if (message.content.length === 0) return false;

  return message.content.every(
    (part) => part.type === "tool-result" && stepCallIds.has(part.toolCallId),
  );
}

/** Append the turn's messages without {@link isSynthesizedToolDup} duplicates. */
export function appendModelResponseMessages(
  transcript: readonly TranscriptMessage[],
  messages: readonly TranscriptMessage[],
  stepCallIds: ReadonlySet<string>,
): TranscriptMessage[] {
  return [...transcript, ...messages.filter((m) => !isSynthesizedToolDup(m, stepCallIds))];
}
