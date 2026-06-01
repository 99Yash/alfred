import type { AgentTranscriptMessage } from "@alfred/contracts";

/**
 * Conservative v1 token estimate used for compaction trip-wires and
 * pre-call guards. The workflow already uses chars / 4 for tool-result
 * tails; keeping the same estimator avoids divergent pressure math until
 * a tokenizer-backed helper lands.
 */
export function estimateTranscriptTokens(messages: readonly AgentTranscriptMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}
