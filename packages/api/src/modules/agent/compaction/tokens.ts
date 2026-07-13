import type { AgentTranscriptMessage } from "@alfred/contracts";

export const CHARS_PER_TOKEN = 4;

export function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * Conservative v1 token estimate used for compaction trip-wires and
 * pre-call guards. The workflow already uses chars / 4 for tool-result
 * tails; keeping the same estimator avoids divergent pressure math until
 * a tokenizer-backed helper lands.
 */
export function estimateTranscriptTokens(messages: readonly AgentTranscriptMessage[]): number {
  return estimateSerializedTokens(messages);
}

/**
 * Estimate the next model input from the prior provider-billed input plus the
 * transcript suffix produced since that call. The billed input already covers
 * the stable system prompt, tool declarations, and prior transcript; adding the
 * serialized in-flight tail keeps every pressure decision on that same request
 * shape without double-counting the stable overhead.
 */
export function estimateNextTurnInputTokens({
  priorInputTokens,
  inFlightTail,
}: {
  priorInputTokens: number;
  inFlightTail: readonly AgentTranscriptMessage[];
}): number {
  return priorInputTokens + estimateTranscriptTokens(inFlightTail);
}

/** Pure Guard 2 decision for whether compaction is not yet worth its round-trip. */
export function shouldSkipCompaction({
  priorChars,
  minimumPriorChars,
  nextTurnInputTokens,
  pressureThresholdTokens,
}: {
  priorChars: number;
  minimumPriorChars: number;
  nextTurnInputTokens: number;
  pressureThresholdTokens: number;
}): boolean {
  return priorChars < minimumPriorChars && nextTurnInputTokens <= pressureThresholdTokens;
}
