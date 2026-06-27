import { sanitizeErrorMessage } from "@alfred/contracts";
import type { SenderExtractionEvent } from "../triage";

export const DEFAULT_DECISION_TRACE_KEY = "default";
const MAX_DECISION_TRACE_KEY_LENGTH = 200;

export function normalizeDecisionTraceKey(decisionKey?: string): string {
  const raw = decisionKey?.trim() ? decisionKey : DEFAULT_DECISION_TRACE_KEY;
  const clean = sanitizeErrorMessage(raw).trim();
  if (!clean) return DEFAULT_DECISION_TRACE_KEY;
  if (clean.length > MAX_DECISION_TRACE_KEY_LENGTH) {
    throw new Error(
      `[agent] decision trace key must be <= ${MAX_DECISION_TRACE_KEY_LENGTH} chars`,
    );
  }
  return clean;
}

/**
 * Registry of durable decision-trace kinds (#219 PR-A). Maps each trace `kind`
 * to its structured payload type. `ctx.trace(kind, record)` is generic over
 * this map, so a producer cannot persist a record whose shape doesn't match the
 * kind it declares — shape drift fails the build instead of writing a malformed
 * row.
 *
 * The executor and the `agent_decision_traces` table are kind-agnostic: they
 * persist `(kind, decisionKey, record-as-jsonb)` without inspecting the
 * payload. To add a producer, add an entry here and call `ctx.trace` from the
 * step. If a domain row must commit atomically with its trace, the domain store
 * may write the same keyed trace before the executor's idempotent insert.
 *
 * triage is the first producer (ADR-0051 sender-extraction event); briefing /
 * memory-extraction / cold-start adopt incrementally by adding entries.
 */
export interface DecisionTraceRegistry {
  "triage.classification": SenderExtractionEvent;
}

export type DecisionTraceKind = keyof DecisionTraceRegistry;
export type DecisionTraceFor<K extends DecisionTraceKind> = DecisionTraceRegistry[K];

export interface DecisionTraceOptions {
  /**
   * Stable per-step discriminator for multiple decisions of the same `kind`.
   * Omit only when the step emits at most one trace for that kind.
   */
  decisionKey?: string;
}

/**
 * A trace collected during a step body, awaiting persistence in the step's
 * commit transaction. Discriminated so `kind` and `record` stay correlated.
 */
export type DecisionTraceRecord = {
  [K in DecisionTraceKind]: { kind: K; decisionKey: string; record: DecisionTraceFor<K> };
}[DecisionTraceKind];
