import { isRecord, type AgentTranscriptMessage } from "@alfred/contracts";

/**
 * Is `message` an SDK-synthesized tool-result dup we should drop from history?
 *
 * Our tools are execute-less, so the dispatcher (`dispatch-tools` step) owns
 * every tool result. The SDK only emits its own `role: "tool"` message when the
 * model hands a tool a schema-invalid input — and that synthesized message
 * carries `tool-result` parts for the very calls the model just made (all in
 * `stepCallIds`). Appending it verbatim leaves TWO `tool_result` blocks for the
 * same `toolCallId` (the SDK's + the dispatcher's); Anthropic then 400s on the
 * next turn ("each tool_use must have a single result"), where Gemini silently
 * tolerated the dup.
 *
 * We return true only when EVERY part targets one of `stepCallIds`, so a
 * hypothetical provider/SDK-executed result for some other call id is preserved
 * rather than silently discarded.
 */
export function isSynthesizedToolDup(
  message: AgentTranscriptMessage,
  stepCallIds: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool") return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every((part) => {
    const id = isRecord(part) ? part.toolCallId : undefined;
    return typeof id === "string" && stepCallIds.has(id);
  });
}

/**
 * Append a model turn's response messages to the transcript, dropping the SDK's
 * synthesized tool-result dups for the calls the dispatcher will author results
 * for ({@link isSynthesizedToolDup}). `stepCallIds` is the set of toolCallIds
 * the model produced this turn (empty when the turn made no tool calls — then
 * nothing is filtered, since a dup can only exist for a call made this turn).
 */
export function appendModelResponseMessages(
  transcript: readonly AgentTranscriptMessage[],
  messages: readonly AgentTranscriptMessage[],
  stepCallIds: ReadonlySet<string>,
): AgentTranscriptMessage[] {
  return [...transcript, ...messages.filter((m) => !isSynthesizedToolDup(m, stepCallIds))];
}
