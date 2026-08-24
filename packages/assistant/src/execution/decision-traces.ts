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
 * Registry of durable decision-trace kinds (#219 PR-A). Maps each trace `kind`
 * to its structured payload type. `ctx.trace(kind, record)` is generic over
 * this map, so a producer cannot persist a record whose shape doesn't match the
 * kind it declares — shape drift fails the build instead of writing a malformed
 * row.
 *
 * The executor and the `agent_decision_traces` table are kind-agnostic: they
 * persist `(kind, decisionKey, record-as-jsonb)` without inspecting the
 * payload. If a domain row must commit atomically with its trace, the domain
 * store may write the same keyed trace before the executor's idempotent insert.
 *
 * This interface is deliberately EMPTY here and OPEN for augmentation: a
 * producer module declares its own kind + payload from inside its own boundary
 *
 *     // in the producing module (e.g. triage), NOT here:
 *     declare module "../agent/decision-traces" {
 *       interface DecisionTraceRegistry {
 *         "my.kind": MyPayload;
 *       }
 *     }
 *
 * so execution owns the trace *seam* without importing any product payload type
 * (that import was the last `agent -> triage` module edge; item 06 removed it).
 * triage is the first producer (ADR-0051 sender-extraction event, declared in
 * `triage/sender-extraction-event.ts`); briefing / memory-extraction /
 * cold-start adopt the same way. NEVER give this an index signature or widen an
 * entry to `unknown`: that silently disables every producer's `ctx.trace`
 * payload check, which is the whole point of the map.
 */
// oxlint-disable-next-line no-empty-interface no-empty-object-type
export interface DecisionTraceRegistry {}

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

/**
 * The kind-agnostic shape every trace carries regardless of its registry
 * entry. The executor collects and persists traces without importing any
 * producer's payload type, so it holds them at this shape;
 * {@link DecisionTraceRecord} is the producer-facing view of the same rows.
 */
export interface DecisionTraceBase {
  kind: string;
  decisionKey: string;
  record: unknown;
}
