import type { AgentTranscriptMessage } from "@alfred/contracts";
import { APPROXIMATE_CHARS_PER_TOKEN } from "@alfred/ai";

export const CHARS_PER_TOKEN = APPROXIMATE_CHARS_PER_TOKEN;

export function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/** Rough chars / 4 estimate, the same one the workflow uses. */
export function estimateTranscriptTokens(messages: readonly AgentTranscriptMessage[]): number {
  return estimateSerializedTokens(messages);
}

/** Last billed input plus the new tail. The billed input already counts the prompt and tools. */
export function estimateNextTurnInputTokens({
  priorInputTokens,
  inFlightTail,
}: {
  priorInputTokens: number;
  inFlightTail: readonly AgentTranscriptMessage[];
}): number {
  return priorInputTokens + estimateTranscriptTokens(inFlightTail);
}

/** True when compaction is not yet worth its model call. */
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
