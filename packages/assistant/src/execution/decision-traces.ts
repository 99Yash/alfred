import { sanitizeErrorMessage } from "@alfred/contracts";

const DEFAULT_DECISION_TRACE_KEY = "default";

const MAX_DECISION_TRACE_KEY_LENGTH = 200;

export function normalizeDecisionTraceKey(decisionKey?: string): string {
  const raw = decisionKey?.trim() ? decisionKey : DEFAULT_DECISION_TRACE_KEY;
  const clean = sanitizeErrorMessage(raw).trim();

  if (!clean) return DEFAULT_DECISION_TRACE_KEY;

  if (clean.length > MAX_DECISION_TRACE_KEY_LENGTH) {
    throw new Error(`[agent] decision trace key must be <= ${MAX_DECISION_TRACE_KEY_LENGTH} chars`);
  }

  return clean;
}

/**
 * Trace kind to payload type, so `ctx.trace` rejects a wrong shape at build time.
 * Empty here: each producer adds its kind in its own module, so execution imports no payload type.
 *
 *     declare module "@alfred/assistant/execution/decision-traces" {
 *       interface DecisionTraceRegistry {
 *         "my.kind": MyPayload;
 *       }
 *     }
 *
 * Never add an index signature or an `unknown` entry: that turns off every payload check.
 */
export interface DecisionTraceRegistry {}

export type DecisionTraceKind = keyof DecisionTraceRegistry;

export type DecisionTraceFor<K extends DecisionTraceKind> = DecisionTraceRegistry[K];

export interface DecisionTraceOptions {
  /** Required when a step emits more than one trace of a kind. */
  decisionKey?: string;
}

/** Discriminated, so `kind` and `record` stay matched. */
export type DecisionTraceRecord = {
  [K in DecisionTraceKind]: { kind: K; decisionKey: string; record: DecisionTraceFor<K> };
}[DecisionTraceKind];

/** The executor's view of a trace, with no producer payload type. */
export interface DecisionTraceBase {
  kind: string;
  decisionKey: string;
  record: unknown;
}
