import type { AgentTranscriptMessage, ToolName } from "@alfred/contracts";

import type {
  ProposedToolCall,
  ToolCallRoundOutcome,
  ToolCallRun,
  ToolSurfaceSource,
} from "../index";
import type { ToolCallDispatchResult, ToolCallRoundAdapter } from "./adapter";
import { completedToolCall, toolResultMessage } from "./result-routing";
import { recordInactiveToolActivation, startToolCallBatchSpan } from "./runtime-spans";

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
        recordInactiveToolActivation(input.run, result.result.recovery.toolName);
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
      if (call.toolName === "system.load_tool" && result.kind === "executed") {
        activeNames = foldExactLoad(activeNames, result.toolResult, restoreSurface);
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
 * Dispatch one round's calls with the approval gate read first.
 *
 * Calls the gate hint marks as free run at once; calls that share an
 * `executionLane` run in model order inside that lane; calls the hint marks as
 * gated run one at a time after the rest, so a round can stage at most one
 * approval card (ADR-0040). A `parked` or `staged` result leaves the batch
 * uncommitted and the whole batch re-dispatches on resume, where the finished
 * siblings short-circuit on `(runId, toolCallId)` idempotency.
 *
 * Every caller takes this path. `interaction` decides tool eligibility
 * (`requiresLiveChat`) and the surface cache key, not the dispatch order: the
 * gate hint and the staging decision read only `(userId, toolName)`, so the
 * schedule is as safe for a sub-agent brief as for a chat turn (#937).
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

function foldExactLoad(
  activeNames: readonly ToolName[],
  result: unknown,
  restoreSurface: RestoreSurface,
): ToolName[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true ||
    !("name" in result) ||
    typeof result.name !== "string"
  ) {
    return [...activeNames];
  }
  return restoreSurface({ kind: "exact", names: [...activeNames, result.name] });
}
