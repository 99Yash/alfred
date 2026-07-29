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
 * Why each kind arms no recovery barrier — the exclusion ledger, one written
 * reason per unrecovered kind.
 *
 * The reasons are prose and nothing checks that they are true. What the table
 * enforces is that one *exists*: a kind classified by neither this table nor a
 * `case` label below does not compile, so a new event kind cannot be added
 * without stating its recoverability. That is the hazard `CLOSURE_POLICY`
 * guards on this event's producer side
 * (`packages/api/src/modules/chat/chat-turn-closure.ts`), where a fourth turn
 * ending compiled clean and silently inherited the `completed` policy.
 *
 * The key type is the whole frame union's `kind` rather than a run-scoped
 * subset, so the two kinds the contract makes structurally unrecoverable sit in
 * the same table as the four excluded by policy.
 */
const NOT_RECOVERABLE = {
  "agent.run": "Workflow run lifecycle, not a chat turn: no bubble replays from it.",
  "agent.progress": "Step telemetry with no client state that survives a reload.",
  "tool.call": "Workflow tool telemetry; the chat trail's cards arrive as `chat.tool`.",
  "artifact.delta":
    "Carries the chat run's own `runId`, and that run armed a barrier at `chat.message` / " +
    '`phase: "started"` before its first delta. Replay is kind-agnostic (one global id range, ' +
    "`modules/events/replay.ts`), so the chat barrier already spans the deltas and excluding " +
    "this kind costs the artifact stream nothing.",
  "inbox.updated": "Carries no `runId`.",
  "memory.fact_learned": "Carries no `runId`.",
} satisfies Partial<Record<EventStreamFrame["kind"], string>>;

/**
 * The `default` arm's return. `TS2345` here on a kind that arms nothing and has
 * no `NOT_RECOVERABLE` reason — a new event kind, or a deleted table entry.
 */
function notRecovered(_kind: keyof typeof NOT_RECOVERABLE): null {
  return null;
}

/**
 * The recovered arms' shared return. `TS2345` here on the other direction: a
 * kind promoted to a `case` while keeping its `NOT_RECOVERABLE` reason, which
 * would leave a ledger entry contradicting the code.
 */
function recoveredRunId(
  _kind: Exclude<EventStreamFrame["kind"], keyof typeof NOT_RECOVERABLE>,
  runId: string,
): string {
  return runId;
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
 * Unlike `frameThreadId` there is no derived *recoverable* kind set. `threadId`
 * is a *coverage* claim — every thread-scoped frame must be gated, so a payload
 * that grows one and is not classified is a bug. Recoverability is a *policy*
 * choice, so a derived set would over-select and force a policy edit at every
 * new run-scoped kind. `NOT_RECOVERABLE` enforces the same claim from the other
 * side: it selects nothing, and both arms below pass `frame.kind` through a
 * guard whose parameter type makes an unclassified kind a compile error.
 *
 * `payload.runId` and `payload.phase` are read unguarded under the caller contract
 * stated on `advanceReplayState`.
 */
function recoverableRunId(frame: EventStreamFrame): string | null {
  switch (frame.kind) {
    case "chat.message":
    case "chat.reasoning":
    case "chat.delta":
    case "chat.tool":
    case "approval.requested":
      return recoveredRunId(frame.kind, frame.payload.runId);
    default:
      return notRecovered(frame.kind);
  }
}
