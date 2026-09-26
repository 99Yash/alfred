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

      const activate = SURFACE_ACTIVATIONS.get(call.toolName);

      if (activate !== undefined && result.kind === "executed") {
        activeNames = foldActivation(
          activeNames,
          activate(result.toolResult, input.run),
          restoreSurface,
        );
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

/**
 * How one tool's result names a tool to activate, if it does.
 *
 * A tool result is `unknown`, so this is a parse at the round's boundary rather
 * than a type: the name it yields is still filtered by `restoreSurface` against
 * the live registry, and the dispatcher still refuses anything the run's
 * envelope forbids. Returns the name as a plain string precisely so nothing
 * here has to assert a cast to `ToolName` to hand it over.
 */
type SurfaceActivator = (result: unknown, run: ToolCallRun) => string | undefined;

/**
 * The two tools whose *result* changes the next turn's active surface.
 *
 * Keyed by plain `string` because that is what a proposed call carries: the
 * lookup is what proves the name is one of ours, and the name a key yields goes
 * back out as a plain string for `restoreSurface` to check.
 *
 * `system.search_tools` resolves a capability the model cannot call yet, and
 * resolving it is the expensive part: the model was paying a full sequential
 * round-trip purely to activate a tool it had just been handed the name of. So
 * the best curated hit it can already run is activated here, and the model calls
 * it directly on the next turn. The `mcp.call` hop stays explicit because
 * `search_tools` is `no_risk` and `mcp.call` is `high` — a search must not be
 * able to promote a high-risk tool into the surface on its own.
 */
const SURFACE_ACTIVATIONS: ReadonlyMap<string, SurfaceActivator> = new Map<
  string,
  SurfaceActivator
>([
  [
    "system.load_tool",
    (result) =>
      isRecord(result) && result.ok === true ? getStringPath(result, "name") : undefined,
  ],
  [
    "system.search_tools",
    (result, run) => {
      const candidates = getPath(result, "candidates");

      if (!Array.isArray(candidates)) return undefined;

      for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;

        const name = getStringPath(candidate, "name");

        // `name`, not `ref`: the curated `mcp.call` entry exists and carries no
        // ref, so a ref test would wave the high-risk tool through.
        if (name === undefined || name === "mcp.call") continue;

        // `searchAvailableTools` ranks unavailable matches in on purpose (so the
        // model can say "Gmail isn't connected"), so an unfiltered first hit is
        // routinely a tool this run cannot execute.
        if (getStringPath(candidate, "availability") !== "available") continue;

        // An absent envelope means unrestricted; a present one is a hard list
        // (the reply-drafting workflow passes exactly one tool), and folding
        // past it would grow a surface the dispatcher can only refuse.
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
