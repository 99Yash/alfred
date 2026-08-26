/**
 * Turn phase-timing thermometer (#902).
 *
 * For each chat turn — one run of the `__chat-turn__` workflow — the two step
 * bodies accumulate wall-clock into durable state: **generation** (the streamed
 * model turn, `agent.streamTurn` → `finalStep`) and **dispatch** (host-side
 * tool-round execution, including sub-agent join parks). Everything else the
 * steps do (hydration, guards, persistence) is left unattributed and read as
 * the residual `other` bucket at emit time. When the run goes terminal, one
 * span under the run trace carries all three readings.
 *
 * The question this answers — *"what fraction of turn latency is tool
 * execution that begins only after generation finished?"* — is the adoption
 * gate for speculative-execution work (#535): overlapping tool dispatch with
 * streamed generation only pays off when slow tools wait behind long
 * generations. Because chat tools dispatch strictly between model steps,
 * every dispatch millisecond here IS dispatch-after-generation.
 *
 * Extending to Code Mode (#535, ADR-0087) stays additive: a future
 * `system.code_run` round already lands in `dispatchMs` via the same step
 * bracket; splitting sandbox execution out later means adding one more flat
 * primitive field to this metadata — never reshaping the existing ones.
 *
 * Querying (Langfuse, name = `runtime.turn.phases`, trace id = run id):
 * the headline share per turn is
 * `dispatchMs / (generationMs + dispatchMs + otherMs)` — precomputed as
 * `dispatchSharePct` for scan-ability. The weekly trend groups spans by
 * ISO week of `startTime` and averages that share; in SQL against the
 * Langfuse exports:
 *
 * ```sql
 * SELECT date_trunc('week', start_time) AS week,
 *        avg((metadata->>'dispatchMs')::numeric
 *            / NULLIF((metadata->>'generationMs')::numeric
 *                     + (metadata->>'dispatchMs')::numeric
 *                     + (metadata->>'otherMs')::numeric, 0)) AS dispatch_share
 * FROM observations
 * WHERE name = 'runtime.turn.phases'
 * GROUP BY 1 ORDER BY 1;
 * ```
 *
 * Same privacy posture as every runtime span: bounded, PII-free timing
 * metadata only; SDK faults swallowed so tracing never breaks the turn it
 * observes.
 */

import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";

/** Stable observation name for the per-turn phase-timing span (#902). */
export const RUNTIME_TURN_PHASES = "runtime.turn.phases";

/** How the run ended — recorded as the span's terminal status. */
export type TurnPhaseOutcome = "completed" | "stopped" | "failed" | "cancelled";

/** The accumulated phase readings, as carried by `ChatRunState`. */
export interface TurnPhaseReading {
  /** Streamed model-turn wall clock (`chat-turn` step brackets). */
  generationMs: number;
  /** Tool-round + sub-agent-join wall clock (`dispatch-tools` brackets). */
  dispatchMs: number;
  /** Total wall clock spent inside step bodies, parks excluded. */
  stepWallMs: number;
}

export interface TurnPhaseEmitArgs {
  /** Run id — doubles as the Langfuse trace id this span hangs under. */
  runId: string;
  /**
   * The run's start instant; the span backdates its opening here so Langfuse
   * derives the whole turn's wall clock as the span duration.
   */
  startedAt: Date | undefined;
  outcome: TurnPhaseOutcome;
  reading: TurnPhaseReading;
  /** Completed model steps this turn ran (`ChatRunState.turnCount`). */
  turns: number;
}

/**
 * The residual bucket: hydration, guards, persistence, routing overhead —
 * step wall-clock not attributed to generation or dispatch. Clamped at zero
 * so clock skew can never produce a negative reading.
 */
export function otherPhaseMs(reading: TurnPhaseReading): number {
  return Math.max(0, reading.stepWallMs - reading.generationMs - reading.dispatchMs);
}

/**
 * Dispatch's share of attributable turn wall-clock, rounded to whole percent.
 * Undefined until the turn has measurable wall-clock (a zero reading has no
 * share), so the field omits rather than sending a misleading 0.
 */
export function dispatchSharePct(reading: TurnPhaseReading): number | undefined {
  const total = reading.generationMs + reading.dispatchMs + otherPhaseMs(reading);
  if (total <= 0) return undefined;
  return Math.round((100 * reading.dispatchMs) / total);
}

/** Pure builder for the span payload. Exported for tests. */
export function buildTurnPhaseSpanInput(args: TurnPhaseEmitArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TURN_PHASES,
    startedAt: args.startedAt ?? new Date(),
    metadata: { turns: args.turns },
  };
}

let turnThermometerStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

/**
 * Emit the terminal `runtime.turn.phases` span for one chat turn. Called once
 * per run end — from the step bodies' completion paths and from the
 * workflow's terminal closure (failure / cancel). A faulted turn closes at
 * level ERROR; every other outcome at DEFAULT. Swallowed downstream by the
 * shared starter, like every runtime span.
 */
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
