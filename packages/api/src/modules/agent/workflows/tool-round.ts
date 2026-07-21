import type { AgentTranscriptMessage } from "@alfred/contracts";
import {
  toolResultMessage,
  type DispatchResult,
  type TerminalDispatchResult,
} from "../../dispatch";
import type { DispatchBatchSpanCloser } from "../runtime-spans";
import type { PendingToolCall } from "./pending-tool-call";

/**
 * One dispatched tool round, shared by the interactive chat turn and the
 * background sub-agent brief so the two can never drift on *how a round runs* —
 * the span-close rule, the staged-before-parked interrupt priority, and the
 * commit pass. What legitimately differs between the two (dispatch ordering, the
 * per-result side effects, and what a terminal/interrupt returns) is injected;
 * everything else lives here once.
 *
 * Result *rendering* is already single-sourced in `dispatch/result-routing`
 * (`toolResultMessage`); this module is its sibling — result *running*.
 */

/**
 * The wake a parked round hands back. Derived from the two `interrupt`-shaped
 * dispatch results (`staged` = HIL approval, `parked` = sub-agent await) so a
 * new interrupt kind can't be forgotten here.
 */
export type DispatchRoundWake = Extract<DispatchResult, { kind: "staged" | "parked" }>["wake"];

/**
 * How this round's batch is dispatched. `serial` runs the calls one at a time in
 * model order, stopping at the first that parks (the background brief). `concurrent-autonomy`
 * overlaps the ungated "autonomy" calls — `Σ(tool)` → `max(tool)` latency — while
 * still dispatching gated writes serially and stopping at the first that stages
 * (the interactive chat turn). `serializeInOrder` names the autonomy calls that
 * must still run in model order despite being ungated (chat's artifact mutations
 * share body state); everything else in the autonomy lane overlaps.
 */
export type ToolDispatchOrdering<Call extends PendingToolCall> =
  | { readonly kind: "serial" }
  | {
      readonly kind: "concurrent-autonomy";
      readonly gateFlags: readonly boolean[];
      readonly serializeInOrder: (call: Call) => boolean;
    };

export interface RunToolRoundArgs<Call extends PendingToolCall> {
  readonly calls: readonly Call[];
  /** Transcript before this round; returned unchanged on an interrupt, extended on commit. */
  readonly transcript: readonly AgentTranscriptMessage[];
  readonly ordering: ToolDispatchOrdering<Call>;
  /**
   * Dispatch one call. The caller builds the workflow-specific `DispatchArgs`
   * and owns the inactive-tool bounce (it mutates caller state under a
   * caller-specific span label), so the round runner treats this as opaque.
   */
  readonly dispatch: (call: Call) => Promise<DispatchResult>;
  /** Opened by the caller (needs the workflow slug + caller label); this owns its close. */
  readonly batchSpan: DispatchBatchSpanCloser | null;
  /**
   * Per-committed-result side effects (durable log rows, live events, artifact
   * context invalidation, sub-agent await folding). Runs in model order, before
   * the `toolResultMessage` append, only on the committed (no-interrupt) path.
   */
  readonly onCommit?: (
    call: Call,
    result: TerminalDispatchResult,
    index: number,
  ) => void | Promise<void>;
}

/**
 * The outcome of a round. `interrupt` means a gated write staged or a sub-agent
 * await parked: the batch is left untouched (nothing committed, transcript
 * unchanged) so the whole batch re-dispatches on resume, where the already-run
 * siblings short-circuit on `(runId, toolCallId)` idempotency and only the
 * newly-unblocked call does real work. `committed` carries the extended
 * transcript plus every terminal result in model order (for the caller's
 * post-round bookkeeping, e.g. `dispatchRoundReissued`).
 */
export type ToolRoundOutcome =
  | { readonly kind: "interrupt"; readonly wake: DispatchRoundWake }
  | {
      readonly kind: "committed";
      readonly transcript: AgentTranscriptMessage[];
      readonly results: readonly DispatchResult[];
    };

/**
 * Run independent autonomy calls concurrently while preserving model order for
 * the calls `serializeInOrder` flags. The two lanes overlap, so a slow lookup
 * does not delay the ordered calls; only the flagged ones (chat's artifact
 * mutations, which share body state) serialize among themselves.
 *
 * Internal to the round runner (the `concurrent-autonomy` ordering's engine);
 * chat's serialization guarantee is pinned through `runToolRound` itself in
 * `artifact-mutation-order.test.ts`.
 */
async function dispatchAutonomyCallsInSafeOrder<
  TCall extends { readonly toolName: string },
  TResult,
>(
  calls: readonly TCall[],
  gateFlags: readonly boolean[],
  serializeInOrder: (call: TCall) => boolean,
  dispatch: (call: TCall) => Promise<TResult>,
): Promise<Array<TResult | undefined>> {
  const results: Array<TResult | undefined> = Array.from({ length: calls.length });
  const independentCalls = calls.flatMap((call, index) =>
    gateFlags[index] || serializeInOrder(call)
      ? []
      : [
          dispatch(call).then((result) => {
            results[index] = result;
          }),
        ],
  );
  const orderedCalls = (async () => {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      if (gateFlags[index] || !serializeInOrder(call)) continue;
      results[index] = await dispatch(call);
    }
  })();
  await Promise.all([...independentCalls, orderedCalls]);
  return results;
}

/** Dispatch the batch per the ordering strategy, returning a sparse, model-ordered
 *  result array (`undefined` slots are calls left undispatched once a stage/park
 *  ended the round — they re-dispatch on resume). */
async function dispatchBatch<Call extends PendingToolCall>(
  calls: readonly Call[],
  ordering: ToolDispatchOrdering<Call>,
  dispatch: (call: Call) => Promise<DispatchResult>,
): Promise<Array<DispatchResult | undefined>> {
  if (ordering.kind === "serial") {
    const results: Array<DispatchResult | undefined> = Array.from({ length: calls.length });
    for (let i = 0; i < calls.length; i++) {
      const result = await dispatch(calls[i]!);
      results[i] = result;
      // A gated stage (HIL) or a sub-agent park ends the round. Leave the rest
      // undispatched so the whole batch re-dispatches on resume (idempotent).
      if (result.kind === "staged" || result.kind === "parked") break;
    }
    return results;
  }

  const { gateFlags, serializeInOrder } = ordering;
  const results = await dispatchAutonomyCallsInSafeOrder(
    calls,
    gateFlags,
    serializeInOrder,
    dispatch,
  );
  // Gated bucket — serial in model order, stop at the first that stages. Staging
  // several at once is wrong: the run parks on one `approvalId`, so a second card
  // would 409 on `wake_mismatch` and each gated row would fire its own email.
  // (A `parked` await is never gated, so it surfaces from the autonomy lane above
  // and is detected after this loop.)
  for (let i = 0; i < calls.length; i++) {
    if (!gateFlags[i]) continue;
    const result = await dispatch(calls[i]!);
    results[i] = result;
    if (result.kind === "staged") break;
  }
  return results;
}

/**
 * Dispatch one tool round and either interrupt (a gated write staged / a
 * sub-agent await parked) or commit every terminal result into the transcript.
 * Owns the batch span's close (per terminal), the staged-before-parked interrupt
 * priority, and the ordered commit pass; the caller owns dispatch construction,
 * per-result side effects, and what each outcome returns.
 */
export async function runToolRound<Call extends PendingToolCall>(
  args: RunToolRoundArgs<Call>,
): Promise<ToolRoundOutcome> {
  const { calls, ordering, dispatch, batchSpan, onCommit } = args;
  try {
    const results = await dispatchBatch(calls, ordering, dispatch);

    // HIL staging takes precedence over a sub-agent park: both leave the batch
    // untouched for re-dispatch, but a staged write is the real user-facing
    // discontinuity to surface first.
    const staged = results.find(
      (result): result is Extract<DispatchResult, { kind: "staged" }> =>
        result?.kind === "staged",
    );
    if (staged) {
      batchSpan?.end("staged", results);
      return { kind: "interrupt", wake: staged.wake };
    }
    const parked = results.find(
      (result): result is Extract<DispatchResult, { kind: "parked" }> =>
        result?.kind === "parked",
    );
    if (parked) {
      batchSpan?.end("parked", results);
      return { kind: "interrupt", wake: parked.wake };
    }

    // No interrupt — every call was dispatched, so each slot is populated. Commit
    // in model order (transcript order is load-bearing): side effects first, then
    // the tool-result message the next model step reads.
    let transcript = [...args.transcript];
    const committed: DispatchResult[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const result = results[i]!;
      // Unreachable after the interrupt returns above; also narrows `result` to a
      // terminal for `onCommit` / `toolResultMessage`.
      if (result.kind === "staged" || result.kind === "parked") continue;
      await onCommit?.(call, result, i);
      transcript = [...transcript, toolResultMessage(call, result)];
      committed.push(result);
    }
    batchSpan?.end("committed", results);
    return { kind: "committed", transcript, results: committed };
  } catch (err) {
    // Close the span as errored (no-op if already ended) and let the caller's
    // workflow-specific cleanup run.
    batchSpan?.end("error");
    throw err;
  }
}
