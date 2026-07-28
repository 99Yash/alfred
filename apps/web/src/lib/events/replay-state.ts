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
 * are separate so an out-of-order chat frame can safely sit behind the cursor.
 */
export function replaySince(state: ReplayState): number {
  const barriers = Object.values(state.activeRuns);
  return barriers.length > 0 ? Math.min(state.cursor, ...barriers) : state.cursor;
}

/** Pure state transition used by both the browser controller and unit tests. */
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
 * not classified is a bug. Recoverability is a *policy* choice: `runId` is on 8
 * of 11 payloads and `agent.run` / `agent.progress` / `tool.call` carry it and
 * are excluded on purpose, so a derived set would over-select and force a policy
 * edit at every new run-scoped kind. The reverse direction — "a new
 * runId-carrying kind should be considered for recovery" — is prose, not a type.
 *
 * Reading `payload.runId` and `payload.phase` unguarded is safe because every
 * frame reaching here came out of `parseEventFrame`'s zod parse: `noteReplayFrame`
 * is the sole production caller and it is fed by `createEventSource`. That is a
 * property of the caller, not of this module — a second caller handing over an
 * unvalidated frame would put a malformed payload straight into a barrier that
 * is persisted to localStorage.
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
