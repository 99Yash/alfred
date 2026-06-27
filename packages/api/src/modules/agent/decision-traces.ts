import type { SenderExtractionEvent } from "../triage";

/**
 * Registry of durable decision-trace kinds (ADR-0077). Maps each trace `kind`
 * to its structured payload type. `ctx.trace(kind, record)` is generic over
 * this map, so a producer cannot persist a record whose shape doesn't match the
 * kind it declares — shape drift fails the build instead of writing a malformed
 * row.
 *
 * The executor and the `agent_decision_traces` table are kind-agnostic: they
 * persist `(kind, record-as-jsonb)` without inspecting the payload. To add a
 * producer, add an entry here and call `ctx.trace` from the step.
 *
 * triage is the first producer (ADR-0051 sender-extraction event); briefing /
 * memory-extraction / cold-start adopt incrementally by adding entries.
 */
export interface DecisionTraceRegistry {
  "triage.classification": SenderExtractionEvent;
}

export type DecisionTraceKind = keyof DecisionTraceRegistry;
export type DecisionTraceFor<K extends DecisionTraceKind> = DecisionTraceRegistry[K];

/**
 * A trace collected during a step body, awaiting persistence in the step's
 * commit transaction. Discriminated so `kind` and `record` stay correlated.
 */
export type DecisionTraceRecord = {
  [K in DecisionTraceKind]: { kind: K; record: DecisionTraceFor<K> };
}[DecisionTraceKind];
