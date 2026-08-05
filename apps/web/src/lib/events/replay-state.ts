import { z } from "zod";

import { isTerminalStatus } from "@alfred/contracts/agent";

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
 * A barrier is deleted by its own run's terminal frame — `chat.message` /
 * `phase: "completed"` for a chat run, or `agent.run` /
 * `phase: "completed" | "failed" | "cancelled" | "blocked"` for a non-chat run (a
 * sub-agent or a user-authored scheduled workflow, which arm on
 * `approval.requested` but never publish `chat.message`). That deletion holds
 * whatever id the frame
 * arrives with, because `advanceReplayState`'s clearing branch never reads
 * `frame.id`. The arming branch carries the matching tolerance: a run whose
 * terminal frame was applied is recorded in `completedRuns`, and a later frame
 * that merely names it arms nothing. So after any sequence of frames — arriving
 * in any id order, which
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
 * Pure state transition.
 *
 * **Callers must hand over a frame that came out of `parseEventFrame`.** Payload
 * fields are read unguarded here and in `barrierRunId` / `releasedRunId`, so
 * validation is a
 * demand on the caller, not a property of this module. The two callers that exist
 * both satisfy it: in production `noteReplayFrame` is the sole entry and
 * `createEventSource` zod-parses every frame before it, and the unit tests build
 * frames through the typed union, which is the same guarantee at compile time. A
 * future caller that hands over an unvalidated frame puts whatever the payload
 * carries into a barrier that is persisted to localStorage.
 */
export function advanceReplayState(state: ReplayState, frame: EventStreamFrame): ReplayState {
  const cursor = Math.max(state.cursor, frame.id);

  const activeRuns = { ...state.activeRuns };
  const completedRuns = { ...state.completedRuns };

  const released = releasedRunId(frame);
  if (released) {
    // The run terminated: release its barrier and record it as completed, so a
    // later frame that merely names it cannot re-arm one. The record holds
    // whatever id the terminal frame arrives with, matching the clearing
    // branch's id-tolerance. Release keys on the run *lifecycle*, so a non-chat
    // run's `agent.run` terminal releases the barrier its `approval.requested`
    // armed, which no `chat.message` will ever come to release.
    delete activeRuns[released];
    completedRuns[released] = frame.id;
  } else {
    const runId = barrierRunId(frame);
    if (runId && completedRuns[runId] === undefined) {
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
      const completedRunsChanged = !sameBarriers(current.completedRuns, next.completedRuns);
      // While a run is active its persisted barrier already supplies the
      // correct reload cursor, so keep high-frequency deltas in memory. Persist
      // lifecycle changes — a barrier arming or clearing, or a run recorded as
      // completed — and idle progress. A `completed` for a run this tab never
      // armed leaves `activeRuns` unchanged but still writes `completedRuns`, and
      // that record must reach localStorage or a fresh tab loses the terminal
      // memory the arming branch relies on to refuse a later stray.
      if (
        next !== current &&
        (barriersChanged || completedRunsChanged || Object.keys(next.activeRuns).length === 0)
      ) {
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
  "agent.run":
    "Workflow run lifecycle, not a chat turn: no bubble replays from it, so it " +
    "arms no barrier. But its terminal phase *releases* one: a non-chat run " +
    "(sub-agent or user-authored workflow) arms a barrier on `approval.requested` " +
    "and never publishes `chat.message`, so `releasedRunId` clears that barrier on " +
    "this kind's terminal phase (`completed` / `failed` / `cancelled` / `blocked`). " +
    "Arming and releasing are " +
    "separate policies — this reason is the arming one.",
  "agent.progress": "Step telemetry with no client state that survives a reload.",
  "tool.call": "Workflow tool telemetry; the chat trail's cards arrive as `chat.tool`.",
  "artifact.delta":
    "Carries the chat run's own `runId`, and replay is kind-agnostic (one global id range, " +
    "`modules/events/replay.ts`), so a client that armed this run's barrier at `chat.message` / " +
    '`phase: "started"` has that barrier span the deltas and gets them back on reload. But the ' +
    "barrier only exists for a client that saw `started`. A client that first observes the run " +
    "through `artifact.delta` alone — a fresh tab, or a reconnect whose resume floor already " +
    "sits above the run's `started` id — arms no barrier, floats the cursor past these deltas, " +
    "and re-loses them on the next reload. That window self-heals: the durable `artifacts` row " +
    "supersedes the live stream once the tool resolves. See `test/events/replay-state.test.ts` " +
    "(the mid-join gap) and campaign item 41's follow-up for the server-side recovery.",
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

/**
 * The frames that carry a run id this module keys a barrier on: the five
 * `SPEAKS_FOR_A_RUN` kinds that *arm* one, plus `agent.run`, which arms nothing
 * but whose terminal phase *releases* one (see `releasedRunId`). These are the
 * only inputs the mint below accepts.
 */
type RunScopedFrame = Extract<
  EventStreamFrame,
  { kind: keyof typeof SPEAKS_FOR_A_RUN | "agent.run" }
>;

/**
 * The arming and releasing arms' shared return, and the only mint of a
 * `BarrierRunId`. `TS2345` here on any kind outside `RunScopedFrame`: a kind
 * with no run id promoted to a `case` in `barrierRunId` or `releasedRunId` does
 * not compile, so an arm cannot mint a barrier under a kind that carries no run.
 *
 * It takes the whole frame rather than a kind plus a run id read off that frame,
 * because two arguments cannot be related: `toBarrierRunId("chat.delta",
 * frame.payload.runId)` from an `agent.progress` arm type-checked, minting a
 * barrier under a kind the ledger excludes. One parameter makes that pair
 * unrepresentable.
 */
function toBarrierRunId(frame: RunScopedFrame): BarrierRunId {
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
 * `payload.runId` is read unguarded under the caller contract stated on
 * `advanceReplayState`.
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

/** The `chat.message` phases, sourced from the frame union so a new phase surfaces here. */
type ChatMessagePhase = Extract<EventStreamFrame, { kind: "chat.message" }>["payload"]["phase"];

/** The `agent.run` phases, sourced from the frame union so a new phase surfaces here. */
type AgentRunPhase = Extract<EventStreamFrame, { kind: "agent.run" }>["payload"]["phase"];

/**
 * Whether a `chat.message` phase ends its run. No `default`: a new `chat.message`
 * phase makes this function's declared `boolean` return fail with TS2366 until it
 * is classified (**tier 1**). This is the old `releasesBarrier`'s inner switch,
 * extracted so the kind `switch` in `releasedRunId` cannot swallow its
 * exhaustiveness in a `default`.
 */
function isTerminalChatPhase(phase: ChatMessagePhase): boolean {
  switch (phase) {
    case "completed":
      return true;
    case "started":
    case "compaction_started":
    case "compaction_finished":
      return false;
  }
}

/**
 * Whether an `agent.run` phase ends its run. No `default`: a new `agent.run`
 * phase fails with TS2366 until it is classified (**tier 1**).
 *
 * Terminal membership is *derived*, not restated. The first arm holds the
 * phases that name a run status (`completed` / `failed` / `cancelled` /
 * `blocked` / `deferred`), and `RUN_STATUS_KIND` (`packages/contracts/src/agent.ts`,
 * read through `isTerminalStatus`) decides each one — so a server that
 * re-classifies a terminal run status cannot leave this rule disagreeing with
 * it. A phase whose name is not a run status is a `TS2345` in that arm, so the
 * arm holds only status-named phases. `deferred` is a *live* status there, so
 * it returns `false`: it is a park, not an end, and keeps the barrier until a
 * later terminal frame or a `chat.message` / `completed` releases it.
 *
 * The second arm holds the intra-run progress phases with no run-status twin —
 * `started`, `step_started`, `step_completed`, `interrupted`, `resumed` — none
 * of which ends a run. `interrupted` sits on status `waiting`; the rest sit on a
 * run that continues.
 */
function isTerminalRunPhase(phase: AgentRunPhase): boolean {
  switch (phase) {
    // Phases that name a run status: RUN_STATUS_KIND decides terminality, so a
    // server re-classification cannot desync this rule.
    case "completed":
    case "failed":
    case "cancelled":
    case "blocked":
    case "deferred":
      return isTerminalStatus(phase);
    // Intra-run progress phases with no run-status counterpart — never terminal.
    case "started":
    case "step_started":
    case "step_completed":
    case "interrupted":
    case "resumed":
      return false;
  }
}

/**
 * The run whose replay barrier a frame *releases*, or `null`. This is the one
 * place the release rule lives; it replaced the old `releasesBarrier` boolean so
 * the arming key (`barrierRunId`) and the release key are read the same way — a
 * branded `BarrierRunId` minted only through `toBarrierRunId`.
 *
 * A chat run releases on `chat.message` / `completed`; a non-chat run (sub-agent
 * or user-authored workflow, which never publishes `chat.message`) releases on
 * `agent.run` / `completed` | `failed` | `cancelled`. Both mint through the same
 * frame-typed door, so a `case` returning `frame.payload.runId` directly is
 * `TS2322`.
 *
 * The kind `switch` has a `default: return null`, so this is **tier 4** on kind
 * coverage: a future run-lifecycle kind that terminates a run is not forced by
 * the compiler to be listed here — a test catches it. The arming partition
 * (`SPEAKS_FOR_A_RUN` / `SPEAKS_FOR_NO_RUN`, `TS2741`) is the chokepoint that
 * surfaces any new kind for classification; this list carries no closed
 * "does-not-release" table, to keep the ledger non-positive.
 *
 * `payload.phase` is read unguarded under the caller contract on
 * `advanceReplayState`.
 */
function releasedRunId(frame: EventStreamFrame): BarrierRunId | null {
  switch (frame.kind) {
    case "chat.message":
      return isTerminalChatPhase(frame.payload.phase) ? toBarrierRunId(frame) : null;
    case "agent.run":
      return isTerminalRunPhase(frame.payload.phase) ? toBarrierRunId(frame) : null;
    default:
      return null;
  }
}
