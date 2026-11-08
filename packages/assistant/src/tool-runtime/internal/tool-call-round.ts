import type { TranscriptMessage } from "@alfred/ai";
import { assertNever, isRecord } from "@alfred/contracts";
import type { ToolName } from "@alfred/contracts";

import type {
  ProposedToolCall,
  ToolCallDispatchArgs,
  ToolCallRoundOutcome,
  ToolCallRun,
  ToolSurfaceSource,
} from "../index";
import type { DeferredDispatch, ToolCallDispatchResult, ToolCallRoundAdapter } from "./adapter";
import type { ToolEffects } from "./registry";
import { completedToolCall, toolResultMessage } from "./result-routing";
import {
  recordRoundToolActivation,
  startToolCallBatchSpan,
  type RoundToolLoadSource,
} from "./runtime-spans";

type RestoreSurface = (source: ToolSurfaceSource) => ToolName[];

export async function runToolCallRound<Call extends ProposedToolCall>(
  input: {
    calls: readonly Call[];
    transcript: readonly TranscriptMessage[];
    run: ToolCallRun;
    activeNames: readonly ToolName[];
    onCallStarted?:
      | ((call: Call, activeNames: readonly ToolName[]) => void | Promise<void>)
      | undefined;
  },
  adapter: ToolCallRoundAdapter,
  restoreSurface: RestoreSurface,
): Promise<ToolCallRoundOutcome<Call>> {
  if (input.calls.length === 0) {
    return {
      kind: "completed",
      transcript: [...input.transcript],
      calls: [],
      activeNames: [...input.activeNames],
      reissue: false,
    };
  }

  const span = startToolCallBatchSpan(input.run, input.calls.length);
  let activeNames = [...input.activeNames];

  try {
    // A deferred call dispatches twice. Announce it once.
    const started = new Set<Call>();

    const prepare = async (call: Call): Promise<ToolCallDispatchArgs> => {
      if (!started.has(call)) {
        started.add(call);
        await input.onCallStarted?.(call, activeNames);
      }

      return { ...input.run, ...call, activeTools: activeNames };
    };

    // An inactive bounce folds the tool into the surface for the reissue.
    const restoreBouncedTool = (result: ToolCallDispatchResult | DeferredDispatch): void => {
      if (result.kind !== "inactive_tool") return;

      recordRoundToolActivation(input.run, result.result.recovery.toolName, "inactive_bounce");
      activeNames = restoreSurface({
        kind: "exact",
        names: [...activeNames, result.result.recovery.toolName],
      });
    };

    const via =
      <Result extends ToolCallDispatchResult | DeferredDispatch>(
        send: (args: ToolCallDispatchArgs) => Promise<Result>,
      ) =>
      async (call: Call): Promise<Result> => {
        const result = await send(await prepare(call));
        restoreBouncedTool(result);

        return result;
      };

    const dispatch: RoundDispatch<Call> = {
      run: via((args) => adapter.dispatch(args)),
      runUnlessGated: via((args) => adapter.dispatchUnlessGated(args)),
    };

    const results = await dispatchGatedConcurrent(input.calls, input.run, adapter, dispatch);

    const staged = results.find(
      (result): result is Extract<ToolCallDispatchResult, { kind: "staged" }> =>
        result?.kind === "staged",
    );

    if (staged) {
      span.end("staged", results);

      return { kind: "waiting", wake: staged.wake, activeNames };
    }

    const parked = results.find(
      (result): result is Extract<ToolCallDispatchResult, { kind: "parked" }> =>
        result?.kind === "parked",
    );

    if (parked) {
      span.end("parked", results);

      return { kind: "waiting", wake: parked.wake, activeNames };
    }

    let transcript = [...input.transcript];
    const calls = [];
    let reissue = false;

    for (const [index, call] of input.calls.entries()) {
      const result = results[index];

      // Only a staged gated call stops dispatch early, and that case returned above.
      if (result === undefined) {
        throw new Error(
          `[tool-call-round] call ${index} (${call.toolName}) has no dispatch result`,
        );
      }

      if (result.kind === "staged" || result.kind === "parked") continue;

      if (result.kind === "inactive_tool") reissue = true;

      let routed = result;

      if (result.kind === "executed") {
        const before = activeNames;
        const activation = surfaceActivation(result.effects.activation, input.run);

        activeNames = foldActivation(activeNames, activation?.name, restoreSurface);

        // `restoreSurface` drops a name it cannot resolve, so mark only a name that is active now.
        if (activation?.loadSource === "search_fold" && isRecord(result.toolResult)) {
          const loaded = activeNames.find((active) => active === activation.name);

          if (loaded !== undefined) {
            routed = { ...result, toolResult: { ...result.toolResult, ...loadedNote(loaded) } };
          }
        }

        if (activation?.loadSource) {
          for (const active of activeNames) {
            if (!before.includes(active)) {
              recordRoundToolActivation(input.run, active, activation.loadSource);
            }
          }
        }
      }

      transcript = [...transcript, toolResultMessage(call, routed)];
      calls.push(completedToolCall(call, routed));
    }

    span.end("committed", results);

    return { kind: "completed", transcript, calls, activeNames, reissue };
  } catch (error) {
    span.end("error");
    throw error;
  }
}

/** The round's two dispatch paths. Both announce the call once and fold an inactive bounce. */
interface RoundDispatch<Call extends ProposedToolCall> {
  run(call: Call): Promise<ToolCallDispatchResult>;
  runUnlessGated(call: Call): Promise<ToolCallDispatchResult | DeferredDispatch>;
}

/**
 * Free calls run at once, same-lane calls run in model order, and gated calls run
 * one at a time last, so a round stages at most one approval card (ADR-0040). A gated or
 * deferred lane call runs in that serial loop, after the rest of its lane.
 * Under chat full autonomy a `waivable` call joins the free calls, read once per round. Dispatch
 * still reads the flag live for each call, and defers a call that would stage a card after a
 * switch to Review. A deferred call wrote no row, and it runs again in the serial lane
 * (ADR-0069). On resume the whole batch re-dispatches; finished calls short-circuit on
 * `(runId, toolCallId)`.
 */
async function dispatchGatedConcurrent<Call extends ProposedToolCall>(
  calls: readonly Call[],
  run: ToolCallRun,
  adapter: ToolCallRoundAdapter,
  dispatch: RoundDispatch<Call>,
): Promise<Array<ToolCallDispatchResult | undefined>> {
  const forecasts = await Promise.all(
    calls.map((call) => adapter.forecastApproval(run.userId, call.toolName)),
  );

  const waived = forecasts.includes("waivable") && (await adapter.readFullAutonomy(run));

  const serial = forecasts.map(
    (forecast) => forecast === "always" || (forecast === "waivable" && !waived),
  );

  const results: Array<ToolCallDispatchResult | undefined> = Array.from({ length: calls.length });
  const deferred = new Set<number>();

  const record = (index: number, result: ToolCallDispatchResult | DeferredDispatch): void => {
    if (result.kind === "deferred") {
      deferred.add(index);

      return;
    }

    results[index] = result;
  };

  // A `waivable` call in this group may defer, so it goes through `runUnlessGated`.
  const runConcurrent = (index: number, call: Call) =>
    forecasts[index] === "none" ? dispatch.run(call) : dispatch.runUnlessGated(call);

  const independent = calls.flatMap((call, index) =>
    serial[index] || adapter.executionLane(call.toolName)
      ? []
      : [runConcurrent(index, call).then((result) => record(index, result))],
  );

  const lanes = new Map<string, Promise<void>>();

  for (const [index, call] of calls.entries()) {
    if (serial[index]) continue;
    const lane = adapter.executionLane(call.toolName);

    if (!lane) continue;
    const prior = lanes.get(lane) ?? Promise.resolve();

    const next = prior.then(async () => {
      record(index, await runConcurrent(index, call));
    });

    lanes.set(lane, next);
  }

  await Promise.all([...independent, ...lanes.values()]);

  // Model order, so a deferred call keeps its place among the gated calls.
  for (const [index, call] of calls.entries()) {
    if (!serial[index] && !deferred.has(index)) continue;
    const result = await dispatch.run(call);
    results[index] = result;

    if (result.kind === "staged") break;
  }

  return results;
}

/** The fields the round adds to a result whose activation folded a tool in. */
interface LoadedNote {
  loaded: ToolName;
  message: string;
}

/**
 * Names the folded tool on a search result. Without it, the model cannot tell which candidate
 * is active and loads it again.
 */
function loadedNote(name: ToolName): LoadedNote {
  return {
    loaded: name,
    message: `${name} is loaded. Call it directly on your next turn; do not load it.`,
  };
}

/**
 * The tool an activation folds into the next turn's surface. A search fold saves the model a
 * load round-trip. `loadSource` is `null` for a load: its handler records its own `model_load`
 * span. Surface membership is not an authority boundary: dispatch still gates each call.
 */
function surfaceActivation(
  activation: ToolEffects["activation"],
  run: ToolCallRun,
): { name: ToolName; loadSource: RoundToolLoadSource | null } | undefined {
  switch (activation?.kind) {
    case undefined:
      return undefined;
    case "load":
      return { name: activation.name, loadSource: null };
    case "search_fold": {
      // An absent envelope means unrestricted.
      const name = activation.names.find(
        (candidate) =>
          run.allowedTools === undefined ||
          run.allowedTools.some((allowed) => allowed === candidate),
      );

      return name === undefined ? undefined : { name, loadSource: "search_fold" };
    }

    default:
      return assertNever(activation, "surface activation kind");
  }
}

function foldActivation(
  activeNames: readonly ToolName[],
  name: ToolName | undefined,
  restoreSurface: RestoreSurface,
): ToolName[] {
  if (name === undefined) return [...activeNames];

  return restoreSurface({ kind: "exact", names: [...activeNames, name] });
}
