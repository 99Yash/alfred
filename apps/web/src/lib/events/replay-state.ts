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
      // Runs whose terminal frame was applied, so a later frame cannot re-arm them.
      // `.default({})` parses older `{ cursor, activeRuns }` values.
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
 * Resume from the oldest active run barrier, else from the cursor.
 * A barrier sits behind the cursor on purpose, so a reload mid-run replays the turn.
 * Frames can arrive in any id order (relay retries), so release ignores `frame.id`.
 */
export function replaySince(state: ReplayState): number {
  const barriers = Object.values(state.activeRuns);

  return barriers.length > 0 ? Math.min(state.cursor, ...barriers) : state.cursor;
}

/** Pure transition. Pass only frames from `parseEventFrame`: payload fields are read unguarded. */
export function advanceReplayState(state: ReplayState, frame: EventStreamFrame): ReplayState {
  const cursor = Math.max(state.cursor, frame.id);

  const activeRuns = { ...state.activeRuns };
  const completedRuns = { ...state.completedRuns };

  const released = releasedRunId(frame);

  if (released) {
    // Record the run as completed so a later frame cannot re-arm it.
    delete activeRuns[released];
    completedRuns[released] = frame.id;
  } else {
    const runId = barrierRunId(frame);

    if (runId && completedRuns[runId] === undefined) {
      const barrier = Math.max(0, frame.id - 1);
      activeRuns[runId] = Math.min(activeRuns[runId] ?? barrier, barrier);
    }
  }

  // Replay resends only ids above the floor, so older completions can go. This keeps the map small.
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

/** Reads the store before every transition, so other tabs' cursor and barriers are kept. */
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

      // Mid-run deltas stay in memory; the barrier covers a reload.
      // Persist barrier and completion changes, and progress while idle.
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
 * The reason each kind arms no replay barrier.
 * With `SPEAKS_FOR_A_RUN` it splits every frame kind, so a new kind must pick a side to compile.
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
    "`packages/assistant/src/realtime/replay.ts`), so a client that armed this run's barrier at `chat.message` / " +
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
 * Kinds that arm a barrier: every kind `SPEAKS_FOR_NO_RUN` does not name.
 * The type does not force an arm to mint; `test/events/replay-state.test.ts` checks that.
 */
const SPEAKS_FOR_A_RUN = {
  "chat.message": true,
  "chat.reasoning": true,
  "chat.delta": true,
  "chat.tool": true,
  "approval.requested": true,
} satisfies Record<Exclude<EventStreamFrame["kind"], keyof typeof SPEAKS_FOR_NO_RUN>, true>;

/** `TS2345` here means a kind arms nothing and has no `SPEAKS_FOR_NO_RUN` reason. */
function speaksForNoRun(_kind: keyof typeof SPEAKS_FOR_NO_RUN): null {
  return null;
}

declare const BARRIER_RUN_ID: unique symbol;

/** A run id minted only by `toBarrierRunId`. Returning `payload.runId` directly fails with `TS2322`. */
type BarrierRunId = string & { readonly [BARRIER_RUN_ID]: true };

/** Frames that arm a barrier, plus `agent.run`, which only releases one. */
type RunScopedFrame = Extract<
  EventStreamFrame,
  { kind: keyof typeof SPEAKS_FOR_A_RUN | "agent.run" }
>;

/** The only `BarrierRunId` mint. Takes the whole frame so kind and run id cannot mismatch. */
function toBarrierRunId(frame: RunScopedFrame): BarrierRunId {
  // SAFETY: the payload was schema-parsed with `runId`; the brand wraps that string.
  return frame.payload.runId as BarrierRunId;
}

/**
 * The run whose barrier this frame arms, or `null`.
 * The list is policy, so it is written out, not derived from payloads.
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

type ChatMessagePhase = Extract<EventStreamFrame, { kind: "chat.message" }>["payload"]["phase"];

type AgentRunPhase = Extract<EventStreamFrame, { kind: "agent.run" }>["payload"]["phase"];

/** No `default`, so a new phase fails with TS2366 until it is classified. */
function isTerminalChatPhase(phase: ChatMessagePhase): boolean {
  switch (phase) {
    case "completed":
      return true;
    case "started":
    case "compaction_started":
    case "compaction_finished":
    case "capacity_retry":
      return false;
  }
}

/**
 * No `default`, so a new phase fails with TS2366 until it is classified.
 * Phase names match run status names by convention only; nothing type-checks that.
 */
function isTerminalRunPhase(phase: AgentRunPhase): boolean {
  switch (phase) {
    // Status-named phases: `isTerminalStatus` decides. `deferred` is live.
    case "completed":
    case "failed":
    case "cancelled":
    case "blocked":
    case "deferred":
      return isTerminalStatus(phase);
    // Progress phases with no run status. Never terminal.
    case "started":
    case "step_started":
    case "step_completed":
    case "interrupted":
    case "resumed":
      return false;
  }
}

/**
 * The run whose barrier this frame releases, or `null`.
 * A chat run releases on `chat.message` `completed`. A sub-agent or workflow never sends
 * `chat.message`, so it releases on a terminal `agent.run` phase.
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
