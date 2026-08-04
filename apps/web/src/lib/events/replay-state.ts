import { z } from "zod";

import type { EventStreamFrame } from "./frame";

export const replayStateSchema = z
  .preprocess(
    (value) =>
      typeof value === "number" ? { cursor: value, activeRuns: {}, completedRuns: {} } : value,
    z.object({
      cursor: z.number().int().nonnegative(),
      activeRuns: z.record(z.string(), z.number().int().nonnegative()),
      // The ids of runs whose `completed` was already applied, so a later frame
      // that merely names one cannot re-arm its barrier. `.default({})` lets a
      // legacy `{ cursor, activeRuns }` value from before this field parse
      // without migration.
      completedRuns: z.record(z.string(), z.number().int().nonnegative()).default({}),
    }),
  )
  .default({ cursor: 0, activeRuns: {}, completedRuns: {} });

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
 * The arming branch carries the matching tolerance: a run whose `completed` was
 * applied is recorded in `completedRuns`, and a later frame that merely names it
 * arms nothing. So after any sequence of frames — arriving in any id order, which
 * `packages/api/src/modules/events/index.ts` warns is routine when the relay
 * retries a row — a run whose `completed` has been applied holds no entry in
 * `activeRuns`, and `since` never freezes below the cursor because of a frame
 * that only names an already-completed run.
 */
export function replaySince(state: ReplayState): number {
  const barriers = Object.values(state.activeRuns);
  return barriers.length > 0 ? Math.min(state.cursor, ...barriers) : state.cursor;
}

/**
 * Whether a frame ends its run and therefore releases its replay barrier.
 *
 * The `switch` deliberately has no `default`: adding a `chat.message` phase
 * makes this function's declared `boolean` return fail with TS2366 until the
 * new phase is classified. This exhausts phases only; it does not enforce
 * which event kinds should release a barrier.
 */
function releasesBarrier(frame: EventStreamFrame): boolean {
  if (frame.kind !== "chat.message") return false;
  switch (frame.payload.phase) {
    case "completed":
      return true;
    case "started":
    case "compaction_started":
    case "compaction_finished":
      return false;
  }
}

/**
 * Pure state transition.
 *
 * **Callers must hand over a frame that came out of `parseEventFrame`.** Payload
 * fields are read unguarded here and in `barrierRunId`, so validation is a
 * demand on the caller, not a property of this module. The two callers that exist
 * both satisfy it: in production `noteReplayFrame` is the sole entry and
 * `createEventSource` zod-parses every frame before it, and the unit tests build
 * frames through the typed union, which is the same guarantee at compile time. A
 * future caller that hands over an unvalidated frame puts whatever the payload
 * carries into a barrier that is persisted to localStorage.
 */
export function advanceReplayState(state: ReplayState, frame: EventStreamFrame): ReplayState {
  const cursor = Math.max(state.cursor, frame.id);
  const runId = barrierRunId(frame);

  const activeRuns = { ...state.activeRuns };
  const completedRuns = { ...state.completedRuns };

  if (runId) {
    if (releasesBarrier(frame)) {
      // The run terminated: release its barrier and record it as completed, so a
      // later frame that merely names it cannot re-arm one. The record holds
      // whatever id the `completed` arrives with, matching the clearing branch's
      // id-tolerance.
      delete activeRuns[runId];
      completedRuns[runId] = frame.id;
    } else if (completedRuns[runId] === undefined) {
      const barrier = Math.max(0, frame.id - 1);
      activeRuns[runId] = Math.min(activeRuns[runId] ?? barrier, barrier);
    }
  }

  // Drop any completion the resume floor has already passed: replay resends only
  // ids strictly above `replaySince`, so a completion at or below the floor can
  // never produce a stray. This bounds the map — it drains to empty whenever the
  // runs go idle (`replaySince === cursor` prunes every completion below cursor).
  const floor = replaySince({ cursor, activeRuns, completedRuns });
  for (const [completedRunId, completedId] of Object.entries(completedRuns)) {
    if (completedId < floor) delete completedRuns[completedRunId];
  }

  if (
    cursor === state.cursor &&
    sameBarriers(state.activeRuns, activeRuns) &&
    sameBarriers(state.completedRuns, completedRuns)
  ) {
    return state;
  }
  return { cursor, activeRuns, completedRuns };
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
 * Why each kind speaks for no replay barrier — the exclusion ledger, one
 * written reason per excluded kind.
 *
 * The reasons are prose and nothing checks that they are true. What the table
 * enforces is that one *exists*: this table and `SPEAKS_FOR_A_RUN` partition the
 * frame union's *membership*, so a kind in neither does not compile and a new
 * event kind cannot be added without stating its barrier policy. That is the
 * hazard `CLOSURE_POLICY`
 * guards on this event's producer side
 * (`packages/api/src/modules/agent/workflows/chat-turn-closure.ts`), where a fourth turn
 * ending compiled clean and silently inherited the `completed` policy.
 *
 * The key type is the whole frame union's `kind` rather than a run-scoped
 * subset, so a kind the payload contract already makes unable to name a run
 * (`inbox.updated` and `memory.fact_learned` today — see their entries) writes
 * its reason here beside a kind excluded by policy. A run-scoped key type would
 * drop those kinds silently instead, and the reason nobody has to write is the
 * one this table exists to demand.
 */
const SPEAKS_FOR_NO_RUN = {
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
 * The other half of the partition: every kind `SPEAKS_FOR_NO_RUN` does not name.
 *
 * This literal, not the `switch`, is what partitions *membership*. A guard
 * called from an arm only enforces the arms it is called from, and `default` is
 * a sink — a hoisted early return, or an explicit `case` returning `null`,
 * diverts a kind before the sink, so the tables and not the guards are what
 * make a kind's classification mandatory. A kind in neither table is `TS2741`
 * (missing key) and a kind in both is `TS2353` (excess property), wherever the
 * `switch` sends it.
 *
 * What membership does **not** buy is an obligation on the arm. The value `true`
 * compels no `case` to mint anything, so `case "chat.tool": return null` retires
 * an included kind with no written reason and compiles clean — the ledger would
 * then say a barrier is armed where the code arms none. Nothing at the type
 * level closes that direction; one runtime assertion per included kind in
 * `test/events/replay-state.test.ts` does, at **tier 4** — the divergence is
 * detected after it is written, not prevented.
 */
const SPEAKS_FOR_A_RUN = {
  "chat.message": true,
  "chat.reasoning": true,
  "chat.delta": true,
  "chat.tool": true,
  "approval.requested": true,
} satisfies Record<Exclude<EventStreamFrame["kind"], keyof typeof SPEAKS_FOR_NO_RUN>, true>;

/**
 * The `default` arm's return. `TS2345` here on a kind that arms nothing and has
 * no `SPEAKS_FOR_NO_RUN` reason — a new event kind, or a deleted table entry.
 */
function speaksForNoRun(_kind: keyof typeof SPEAKS_FOR_NO_RUN): null {
  return null;
}

declare const BARRIER_RUN_ID: unique symbol;

/**
 * A run id that came out of `toBarrierRunId`. The brand is why no arm can
 * produce one without routing through that mint: a `case` returning
 * `frame.payload.runId` directly is `TS2322` against `barrierRunId`'s
 * return type, which is the shape an author reaches for the moment a kind needs
 * arm-specific handling.
 */
type BarrierRunId = string & { readonly [BARRIER_RUN_ID]: true };

/** The frames `SPEAKS_FOR_A_RUN` names — the only input the mint below accepts. */
type BarrierFrame = Extract<EventStreamFrame, { kind: keyof typeof SPEAKS_FOR_A_RUN }>;

/**
 * The included arms' shared return, and the only mint of a `BarrierRunId`.
 * `TS2345` here on the other direction: a kind promoted to a `case` while
 * keeping its `SPEAKS_FOR_NO_RUN` reason, which would leave a ledger entry
 * contradicting the code.
 *
 * It takes the whole frame rather than a kind plus a run id read off that frame,
 * because two arguments cannot be related: `toBarrierRunId("chat.delta",
 * frame.payload.runId)` from an `agent.progress` arm type-checked, minting a
 * barrier under a kind the ledger excludes. One parameter makes that pair
 * unrepresentable.
 */
function toBarrierRunId(frame: BarrierFrame): BarrierRunId {
  return frame.payload.runId as BarrierRunId;
}

/**
 * The run whose replay barrier a frame may arm or release, or `null` for a kind
 * this module does not let speak for one.
 *
 * A `switch` and not the `Set<EventKind>` this used to be: a runtime membership
 * test narrows neither the key nor the object, so with the Set the `runId` read
 * came off `unknown` and needed two guards the compiler could not check. As
 * `case` labels the five kinds are checked against `@alfred/contracts/events`
 * instead — renaming `runId`, or adding a `case` for a kind that carries none,
 * is a compile error here rather than a `null` that silently stops establishing
 * a barrier.
 *
 * Unlike `frameThreadId` there is no set derived from the *payloads*. `threadId`
 * is a *coverage* claim — every thread-scoped frame must be gated, so a payload
 * that grows one and is not classified is a bug. Replay is kind-agnostic, so
 * this list is not about what survives a reload: it names the frames allowed to
 * speak for a run's barrier, and that is policy, which is why it is written
 * rather than derived. `SPEAKS_FOR_NO_RUN` and `SPEAKS_FOR_A_RUN` state that
 * policy and partition the union's membership — the two guards below only route
 * `frame.kind` into the halves those tables define, and no type makes an
 * included arm actually arm anything (see `SPEAKS_FOR_A_RUN`).
 *
 * `payload.runId` and `payload.phase` are read unguarded under the caller contract
 * stated on `advanceReplayState`.
 */
function barrierRunId(frame: EventStreamFrame): BarrierRunId | null {
  switch (frame.kind) {
    case "chat.message":
    case "chat.reasoning":
    case "chat.delta":
    case "chat.tool":
    case "approval.requested":
      return toBarrierRunId(frame);
    default:
      return speaksForNoRun(frame.kind);
  }
}
