import { z } from "zod";

import type { EventStreamFrame } from "./frame";

export const replayStateSchema = z
  .preprocess(
    (value) => (typeof value === "number" ? { cursor: value, activeRuns: {} } : value),
    z.object({
      cursor: z.number().int().nonnegative(),
      activeRuns: z.record(z.string(), z.number().int().nonnegative()),
    }),
  )
  .default({ cursor: 0, activeRuns: {} });

export type ReplayState = z.infer<typeof replayStateSchema>;

export interface ReplayStateStore {
  read: () => ReplayState;
  write: (state: ReplayState) => void;
}

/**
 * The next connection resumes from the oldest active chat barrier. While idle,
 * it resumes from the latest frame seen. Cursor progress and recovery barriers
 * are separate so a barrier can deliberately sit *behind* the cursor: a reload
 * during a run resumes from before that run's first frame rather than from the
 * newest id seen, which is what replays the in-flight turn.
 *
 * A barrier is deleted only by its own run's `chat.message` / `phase:
 * "completed"` frame, and that deletion holds whatever id the frame arrives
 * with, because `advanceReplayState`'s clearing branch never reads `frame.id`.
 * The arming branch has no matching tolerance, and that is a known gap rather
 * than a property of this module: a recoverable frame applied *after* its run's
 * `completed` re-arms that run's barrier, and nothing can clear it again
 * (a run publishes `completed` at most once), so `since` freezes at that
 * barrier and is persisted. Arrival order cannot be assumed away —
 * `packages/api/src/modules/events/index.ts` states that ids may arrive out of
 * order when the relay retries a row and that consumers must be id-tolerant.
 */
export function replaySince(state: ReplayState): number {
  const barriers = Object.values(state.activeRuns);
  return barriers.length > 0 ? Math.min(state.cursor, ...barriers) : state.cursor;
}

/**
 * Pure state transition.
 *
 * **Callers must hand over a frame that came out of `parseEventFrame`.** Payload
 * fields are read unguarded here and in `recoverableRunId`, so validation is a
 * demand on the caller, not a property of this module. The two callers that exist
 * both satisfy it: in production `noteReplayFrame` is the sole entry and
 * `createEventSource` zod-parses every frame before it, and the unit tests build
 * frames through the typed union, which is the same guarantee at compile time. A
 * future caller that hands over an unvalidated frame puts whatever the payload
 * carries into a barrier that is persisted to localStorage.
 */
export function advanceReplayState(state: ReplayState, frame: EventStreamFrame): ReplayState {
  const cursor = Math.max(state.cursor, frame.id);
  const runId = recoverableRunId(frame);
  if (!runId) return cursor === state.cursor ? state : { ...state, cursor };

  const activeRuns = { ...state.activeRuns };
  if (frame.kind === "chat.message" && frame.payload.phase === "completed") {
    delete activeRuns[runId];
  } else {
    const barrier = Math.max(0, frame.id - 1);
    activeRuns[runId] = Math.min(activeRuns[runId] ?? barrier, barrier);
  }

  return { cursor, activeRuns };
}

/**
 * Read before every transition instead of caching a tab-local cursor. That
 * makes sequential cross-tab writes monotonic and keeps active-run barriers
 * discovered by another tab in the shared state.
 *
 * `noteFrame` inherits `advanceReplayState`'s requirement on its caller: the
 * frame must be one `parseEventFrame` produced.
 */
export function createReplayStateController(store: ReplayStateStore) {
  let maxSeenId = 0;
  return {
    since: () => replaySince(store.read()),
    noteFrame: (frame: EventStreamFrame) => {
      const current = store.read();
      maxSeenId = Math.max(maxSeenId, current.cursor, frame.id);
      const base = maxSeenId === current.cursor ? current : { ...current, cursor: maxSeenId };
      const next = advanceReplayState(base, frame);
      const barriersChanged = !sameBarriers(current.activeRuns, next.activeRuns);
      // While a run is active its persisted barrier already supplies the
      // correct reload cursor, so keep high-frequency deltas in memory. Persist
      // only lifecycle changes and idle progress.
      if (next !== current && (barriersChanged || Object.keys(next.activeRuns).length === 0)) {
        store.write(next);
      }
    },
  };
}

function sameBarriers(left: ReplayState["activeRuns"], right: ReplayState["activeRuns"]): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([runId, barrier]) => right[runId] === barrier);
}

/**
 * The run a frame arms or releases a recovery barrier for, or `null` for a kind
 * this module does not recover.
 *
 * A `switch` and not the `Set<EventKind>` this used to be: a runtime membership
 * test narrows neither the key nor the object, so with the Set the `runId` read
 * came off `unknown` and needed two guards the compiler could not check. As
 * `case` labels the five kinds are checked against `@alfred/contracts/events`
 * instead — renaming `runId`, or adding a `case` for a kind that carries none,
 * is a compile error here rather than a `null` that silently stops establishing
 * a barrier.
 *
 * Unlike `frameThreadId` there is deliberately **no** derived kind set and no
 * exhaustiveness guard on the `default` arm. `threadId` is a *coverage* claim —
 * every thread-scoped frame must be gated, so a payload that grows one and is
 * not classified is a bug. Recoverability is a *policy* choice: `runId` is on 9
 * of the 11 payloads (only `memory.fact_learned` and `inbox.updated` lack it),
 * and **four** of those nine carry it and are excluded on purpose — `agent.run`,
 * `agent.progress`, `tool.call` and `artifact.delta`. So a derived set would
 * over-select and force a policy edit at every new run-scoped kind. Note the
 * fourth: `artifact.delta` never arms or lowers a barrier **on its own**, and
 * excluding it costs the artifact stream nothing, because its only publisher
 * (`workflows/stream-model-turn.ts`, reached only from `chat-turn`) publishes
 * under the chat run's own `runId`, and that run armed a barrier at
 * `chat.message` / `phase: "started"` before its first delta. Replay is
 * kind-agnostic — one global id range with no kind filter
 * (`modules/events/replay.ts`) — so the chat barrier already spans the deltas,
 * and after a reload the client's stream map is empty, so the replayed deltas
 * are reassembled rather than dropped on `use-artifact-stream`'s seq guard. Do
 * **not** "fix" the exclusion by adding `case "artifact.delta"`: that arms a
 * second barrier only a `chat.message` can release. The reverse direction — "a
 * new runId-carrying kind should be considered for recovery" — is prose, not a
 * type.
 *
 * `payload.runId` and `payload.phase` are read unguarded under the caller contract
 * stated on `advanceReplayState`. The `isRecord` and `typeof` guards this replaced
 * bought less than their shape suggested, but not nothing. For a payload the types
 * permit they were inert: a missing `runId` already early-returned with no barrier,
 * and a `phase` other than `"completed"` already armed one. For a payload the types
 * now forbid, exactly two behaviours changed:
 *
 * - A **truthy non-string `runId`** (say `5`) used to be rejected by the `typeof`
 *   check; it now arms `activeRuns["5"]` under a coerced key, which
 *   `createReplayStateController` persists and `replayStateSchema` re-accepts on the
 *   next load, freezing `since` there. So the guard did stand between one malformed
 *   payload and a wrong, persisted barrier.
 * - A **`null` or `undefined`** payload used to be skipped by `isRecord` and now
 *   throws at `frame.payload.runId`. Only those two throw: a string, number, boolean
 *   or array payload reads `undefined` off `.runId` and takes the same silent
 *   no-barrier path as before, since `isRecord` rejected arrays and non-plain
 *   prototypes too. Because `noteReplayFrame` runs *before* `openEventStream`'s
 *   subscriber fan-out, a throw here would drop the frame for every subscriber.
 *
 * Both are unreachable today: every payload schema is a flat `z.object` and all nine
 * `runId` declarations are `z.string().min(1)`, so neither shape survives
 * `parseEventFrame`, and a non-object output type would not compile at
 * `frame.payload.runId`. They are reachable only behind a validator that does not
 * validate.
 */
function recoverableRunId(frame: EventStreamFrame): string | null {
  switch (frame.kind) {
    case "chat.message":
    case "chat.reasoning":
    case "chat.delta":
    case "chat.tool":
    case "approval.requested":
      return frame.payload.runId;
    default:
      return null;
  }
}
