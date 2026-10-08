/**
 * Turn phase thermometer (#902): split each chat turn into generation, dispatch,
 * and the residual `other`, as one span per run.
 * Tools dispatch only between model steps, so all dispatch time comes after generation.
 * That share gates speculative execution (#535).
 */

import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";

export const RUNTIME_TURN_PHASES = "runtime.turn.phases";

export type TurnPhaseOutcome = "completed" | "stopped" | "failed" | "cancelled";

export interface TurnPhaseReading {
  generationMs: number;
  /** Includes sub-agent join parks. */
  dispatchMs: number;
  /** Time inside step bodies, parks excluded. */
  stepWallMs: number;
}

export interface TurnPhaseEmitArgs {
  /** Also the Langfuse trace id. */
  runId: string;
  /** The span starts here, so its duration is the whole turn. */
  startedAt: Date | undefined;
  outcome: TurnPhaseOutcome;
  reading: TurnPhaseReading;
  turns: number;
}

/** Step time outside generation and dispatch. Clamped at zero against clock skew. */
export function otherPhaseMs(reading: TurnPhaseReading): number {
  return Math.max(0, reading.stepWallMs - reading.generationMs - reading.dispatchMs);
}

/** Dispatch share in whole percent. Undefined for a zero reading, not a misleading 0. */
export function dispatchSharePct(reading: TurnPhaseReading): number | undefined {
  const total = reading.generationMs + reading.dispatchMs + otherPhaseMs(reading);

  if (total <= 0) return undefined;

  return Math.round((100 * reading.dispatchMs) / total);
}

export function buildTurnPhaseSpanInput(args: TurnPhaseEmitArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TURN_PHASES,
    startedAt: args.startedAt ?? new Date(),
    metadata: { turns: args.turns },
  };
}

let turnThermometerStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

/** Emit the span once per run end. SDK faults are swallowed by the shared starter. */
export function emitTurnPhaseThermometer(args: TurnPhaseEmitArgs): void {
  const span = turnThermometerStarter(buildTurnPhaseSpanInput(args));
  const { reading } = args;
  const share = dispatchSharePct(reading);
  span.end({
    status: args.outcome,
    ...(args.outcome === "failed" ? { level: "ERROR" as const } : {}),
    metadata: {
      outcome: args.outcome,
      generationMs: reading.generationMs,
      dispatchMs: reading.dispatchMs,
      otherMs: otherPhaseMs(reading),
      ...(share === undefined ? {} : { dispatchSharePct: share }),
    },
  });
}

export function _setTurnThermometerStarterForTests(
  starter: (input: RuntimeSpanInput) => RuntimeSpanCloser,
): () => void {
  const previous = turnThermometerStarter;
  turnThermometerStarter = starter;

  return () => {
    turnThermometerStarter = previous;
  };
}
