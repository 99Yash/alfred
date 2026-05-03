/** What `metered()` writes to `api_call_log`. Extracted post-hoc from the SDK result. */
export interface CallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Discriminator for `api_call_log.kind`. New kinds land here as integrations arrive. */
export type CallKind = "llm" | "embedding" | "web_search" | "transcription" | "tool_api";

/**
 * Caller-supplied attribution and free-form metadata persisted with each
 * call row. Attribution columns are nullable — ad-hoc test calls and
 * cold-start research run outside an agent and still want metering.
 */
export interface CallAttribution {
  userId?: string;
  runId?: string;
  stepId?: string;
  attempt?: number;
  messageId?: string;
  /**
   * Override `api_call_log.kind`. The `meteredGenerateText` /
   * `meteredGenerateObject` wrappers default to `'llm'`; pass
   * `'web_search'` here when routing a Perplexity Sonar (or future
   * search-shaped) model so cost rollups bucket it correctly per
   * ADR-0015. `meteredEmbed` always uses `'embedding'` regardless.
   */
  kind?: CallKind;
}

export interface MeteredMeta extends CallAttribution {
  kind: CallKind;
  provider: string;
  model: string;
  /**
   * Stable per-call key. Forwarded to the provider's idempotency-key header
   * when supported; also tags the Langfuse span. Defaults to a generated
   * UUID when omitted, but callers inside an agent step should pass
   * `${runId}:${stepId}:${attempt}` to make replays grep-able.
   */
  idempotencyKey?: string;
  /** Trimmed model params surfaced to the log row's `request_meta`. Avoid full prompts here. */
  requestMeta?: Record<string, unknown>;
  /** Human-readable name surfaced in Langfuse — defaults to `${provider}/${model}`. */
  name?: string;
}

/** What the runtime extracts from a successful SDK result for billing + log shape. */
export interface MeteredResult {
  usage?: CallUsage;
  /** Surfaced to `response_meta` (finish_reason, model id echoed back, tool_calls count, etc.). */
  responseMeta?: Record<string, unknown>;
}

export type ResultExtractor<T> = (value: T) => MeteredResult;
