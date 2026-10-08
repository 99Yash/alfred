import { getPath, getStringPath, isRecord } from "@alfred/contracts";
import type { AgentTranscriptMessage, ToolName } from "@alfred/contracts";

import type {
  ProposedToolCall,
  ToolCallRoundOutcome,
  ToolCallRun,
  ToolSurfaceSource,
} from "../index";
import type { ToolCallDispatchResult, ToolCallRoundAdapter } from "./adapter";
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
    transcript: readonly AgentTranscriptMessage[];
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
    const dispatch = async (call: Call): Promise<ToolCallDispatchResult> => {
      await input.onCallStarted?.(call, activeNames);
      const result = await adapter.dispatch({ ...input.run, ...call, activeTools: activeNames });

      if (result.kind === "inactive_tool") {
        recordRoundToolActivation(input.run, result.result.recovery.toolName, "inactive_bounce");
        activeNames = restoreSurface({
          kind: "exact",
          names: [...activeNames, result.result.recovery.toolName],
        });
      }

      return result;
    };

    const results = await dispatchGatedConcurrent(input.calls, input.run.userId, adapter, dispatch);

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

    for (let index = 0; index < input.calls.length; index += 1) {
      const call = input.calls[index]!;
      const result = results[index]!;

      if (result.kind === "staged" || result.kind === "parked") continue;
      transcript = [...transcript, toolResultMessage(call, result)];
      calls.push(completedToolCall(call, result));

      if (result.kind === "inactive_tool") reissue = true;

      const activation = SURFACE_ACTIVATIONS.get(call.toolName);

      if (activation !== undefined && result.kind === "executed") {
        const before = activeNames;

        activeNames = foldActivation(
          activeNames,
          activation.activate(result.toolResult, input.run),
          restoreSurface,
        );

        if (activation.loadSource !== null) {
          for (const name of activeNames) {
            if (!before.includes(name)) {
              recordRoundToolActivation(input.run, name, activation.loadSource);
            }
          }
        }
      }
    }

    span.end("committed", results);

    return { kind: "completed", transcript, calls, activeNames, reissue };
  } catch (error) {
    span.end("error");
    throw error;
  }
}

/**
 * Free calls run at once, same-lane calls run in model order, and gated calls run
 * one at a time last, so a round stages at most one approval card (ADR-0040).
 * On resume the whole batch re-dispatches; finished calls short-circuit on
 * `(runId, toolCallId)`.
 */
async function dispatchGatedConcurrent<Call extends ProposedToolCall>(
  calls: readonly Call[],
  userId: string,
  adapter: ToolCallRoundAdapter,
  dispatch: (call: Call) => Promise<ToolCallDispatchResult>,
): Promise<Array<ToolCallDispatchResult | undefined>> {
  const gateFlags = await Promise.all(
    calls.map((call) => adapter.wouldWaitForApproval(userId, call.toolName)),
  );

  const results: Array<ToolCallDispatchResult | undefined> = Array.from({ length: calls.length });

  const independent = calls.flatMap((call, index) =>
    gateFlags[index] || adapter.executionLane(call.toolName)
      ? []
      : [
          dispatch(call).then((result) => {
            results[index] = result;
          }),
        ],
  );

  const lanes = new Map<string, Promise<void>>();

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;

    if (gateFlags[index]) continue;
    const lane = adapter.executionLane(call.toolName);

    if (!lane) continue;
    const prior = lanes.get(lane) ?? Promise.resolve();

    const next = prior.then(async () => {
      results[index] = await dispatch(call);
    });

    lanes.set(lane, next);
  }

  await Promise.all([...independent, ...lanes.values()]);

  for (let index = 0; index < calls.length; index += 1) {
    if (!gateFlags[index]) continue;
    const result = await dispatch(calls[index]!);
    results[index] = result;

    if (result.kind === "staged") break;
  }

  return results;
}

/** Reads a tool name to activate from a result. `restoreSurface` validates it. */
type SurfaceActivator = (result: unknown, run: ToolCallRun) => string | undefined;

/** `loadSource` is `null` when the tool's handler records its own load span. */
interface SurfaceActivation {
  activate: SurfaceActivator;
  loadSource: RoundToolLoadSource | null;
}

/**
 * The tools whose result changes the next turn's surface. Search folds its best
 * runnable curated hit in, which saves the model a load round-trip.
 * Surface membership is not an authority boundary: dispatch still gates each call.
 */
const SURFACE_ACTIVATIONS: ReadonlyMap<string, SurfaceActivation> = new Map([
  [
    "system.load_tool",
    {
      // The `system.load_tool` handler records its own `model_load` span.
      loadSource: null,
      activate: (result) =>
        isRecord(result) && result.ok === true ? getStringPath(result, "name") : undefined,
    },
  ],
  [
    "system.search_tools",
    {
      loadSource: "search_fold",
      activate: (result, run) => {
        const candidates = getPath(result, "candidates");

        if (!Array.isArray(candidates)) return undefined;

        for (const candidate of candidates) {
          if (!isRecord(candidate)) continue;

          const name = getStringPath(candidate, "name");

          // Test `name`, not `ref`: the curated `mcp.call` entry has no ref.
          if (name === undefined || name === "mcp.call") continue;

          // Search also ranks unavailable matches, so skip them.
          if (getStringPath(candidate, "availability") !== "available") continue;

          // An absent envelope means unrestricted.
          if (
            run.allowedTools !== undefined &&
            !run.allowedTools.some((allowed) => allowed === name)
          ) {
            continue;
          }

          return name;
        }

        return undefined;
      },
    },
  ],
]);

function foldActivation(
  activeNames: readonly ToolName[],
  name: string | undefined,
  restoreSurface: RestoreSurface,
): ToolName[] {
  if (name === undefined) return [...activeNames];

  return restoreSurface({ kind: "exact", names: [...activeNames, name] });
}
