import { isRecord } from "@alfred/contracts";
import type { EventKind } from "@alfred/contracts/events";
import { z } from "zod";

const recoverableChatKinds = new Set<EventKind>([
  "chat.message",
  "chat.reasoning",
  "chat.delta",
  "chat.tool",
  "approval.requested",
]);

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

export interface ReplayFrame {
  id: number;
  kind: EventKind;
  payload: unknown;
}

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
export function advanceReplayState(state: ReplayState, frame: ReplayFrame): ReplayState {
  const cursor = Math.max(state.cursor, frame.id);
  const runId = recoverableRunId(frame);
  if (!runId) return cursor === state.cursor ? state : { ...state, cursor };

  const activeRuns = { ...state.activeRuns };
  if (
    frame.kind === "chat.message" &&
    isRecord(frame.payload) &&
    frame.payload.phase === "completed"
  ) {
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
    noteFrame: (frame: ReplayFrame) => {
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

function recoverableRunId(frame: ReplayFrame): string | null {
  if (!recoverableChatKinds.has(frame.kind) || !isRecord(frame.payload)) return null;
  return typeof frame.payload.runId === "string" ? frame.payload.runId : null;
}
