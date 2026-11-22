import { toDisplayText, type WakeCondition } from "@alfred/contracts";

import {
  AWAIT_SUB_AGENT_CEILING_MS,
  scheduleSubAgentJoinWakeJob,
} from "./sub-agent-join-wake-queue";
import { subAgentDoneSignalName } from "./sub-agent-metadata";
import {
  isTerminalChildStatus,
  listSpawnedChildRuns,
  shouldResolveWithoutParking,
  type ChildRunOutcome,
  type SpawnedChildRun,
} from "./sub-agent-children";
import { PREVIEW_CHARS } from "./workflows/tool-preview";

/**
 * How a parent joins a child sub-agent. The sweep never resumes `waiting` runs, so a park
 * needs a backstop. Only this module can build the `park` arm, and its wake carries the
 * deadline that the join reconciler reads from Postgres.
 */
type JoinChildRunResult =
  | { kind: "resolved"; outcome: ChildRunOutcome }
  | { kind: "park"; wake: ParkWake };

declare const parkWakeBrand: unique symbol;

/**
 * A `sub_agent_done` signal wake with a persisted deadline, which the join reconciler reads. Only
 * {@link joinChildOutcome} mints it, so no caller can park a run without that backstop. The
 * contract field is optional (zod infers `?: string | undefined`), so the intersection, not
 * `Required`, makes it a plain `string` here.
 */
type ParkWake = Extract<WakeCondition, { kind: "signal" }> & {
  deadlineAt: string;
} & {
  readonly [parkWakeBrand]: true;
};

function mintParkWake(childRunId: string, deadlineAt: string): ParkWake {
  // SAFETY: the only mint; every park it builds carries a deadline.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand's only mint
  return {
    kind: "signal",
    name: subAgentDoneSignalName(childRunId),
    deadlineAt,
  } satisfies Extract<WakeCondition, { kind: "signal" }> & { deadlineAt: string } as ParkWake;
}

/** Injected so the protocol is testable without a DB or Redis. */
interface JoinChildRunDeps {
  scheduleWake: typeof scheduleSubAgentJoinWakeJob;
}

/**
 * Decide park or fold from one child value. The value carries the row's id, the parent it was
 * read under, and the outcome of that row, so a caller cannot pass child A's outcome next to
 * child B's id as free arguments. A hand-built or spread `SpawnedChildRun` literal still
 * compiles: only `listSpawnedChildRuns` binds the id and parent to the row it checked.
 */
async function joinChildOutcome(
  child: SpawnedChildRun,
  deps: JoinChildRunDeps,
): Promise<JoinChildRunResult> {
  // Past the ceiling the child is reported, not parked again, so a stuck child cannot loop.
  if (shouldResolveWithoutParking(child.outcome))
    return { kind: "resolved", outcome: child.outcome };

  // The child's own signal can be lost in a race, skipped by a cancel, or dropped by a crash.
  // The Redis job is the fast path. The deadline in the wake is the backstop if the job is lost.
  // The deadline counts from the join, not from the park commit, the same as the Redis delay.
  const deadlineAt = new Date(Date.now() + AWAIT_SUB_AGENT_CEILING_MS).toISOString();
  await deps.scheduleWake({
    childRunId: child.id,
    parentRunId: child.parentRunId,
    delayMs: AWAIT_SUB_AGENT_CEILING_MS,
  });

  return { kind: "park", wake: mintParkWake(child.id, deadlineAt) };
}

/** Injected so the join of every spawned child is testable without a DB or Redis. */
export interface JoinSpawnedChildrenDeps {
  listChildren: typeof listSpawnedChildRuns;
  scheduleWake: typeof scheduleSubAgentJoinWakeJob;
}

const defaultJoinSpawnedChildrenDeps: JoinSpawnedChildrenDeps = {
  listChildren: listSpawnedChildRuns,
  scheduleWake: scheduleSubAgentJoinWakeJob,
};

/**
 * The join of every child that a parent spawned and did not fold yet (ADR-0073; ADR-0130
 * decision 6, owner 2026-11-22: the runtime joins, and the model has no await tool).
 * `notes` hands each finished child's outcome to the model. `park` is the wake of the first
 * child that still runs, or `null` when no child runs.
 */
export interface SpawnedChildrenJoin {
  notes: string[];
  foldedChildRunIds: string[];
  park: ParkWake | null;
}

export async function joinSpawnedChildren(
  args: { parentRunId: string; userId: string; foldedChildRunIds: readonly string[] },
  deps: JoinSpawnedChildrenDeps = defaultJoinSpawnedChildrenDeps,
): Promise<SpawnedChildrenJoin> {
  const children = await deps.listChildren({ parentRunId: args.parentRunId, userId: args.userId });
  const notes: string[] = [];
  const folded = [...args.foldedChildRunIds];
  let park: ParkWake | null = null;

  for (const child of children) {
    if (folded.includes(child.id)) continue;
    const join = await joinChildOutcome(child, deps);

    if (join.kind === "park") {
      park ??= join.wake;
      continue;
    }

    // Stop tracking a resolved child, so a stuck one cannot park again forever.
    notes.push(childResultNote(child.id, join.outcome));
    folded.push(child.id);
  }

  return { notes, foldedChildRunIds: folded, park };
}

/** Truncated, model-readable rendering of a folded child's output or error. */
function renderChildOutcome(value: unknown): string {
  const text = toDisplayText(value);

  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** A note that hands a child's outcome to the parent. No tool call exists to attach it to. */
function childResultNote(childRunId: string, outcome: ChildRunOutcome): string {
  if (!isTerminalChildStatus(outcome.status)) {
    // The join gave up: no dead-man timer, or the child outran the wait ceiling.
    const why = outcome.reason ? ` (${outcome.reason})` : ` (still ${outcome.status})`;

    return (
      `A sub-agent you spawned (childRunId ${childRunId}) did not finish in time${why}. ` +
      "Answer now with what you already have. Tell the user that part of the work is still in progress; do not fabricate its result."
    );
  }

  const detail =
    outcome.status === "completed"
      ? `completed with result:\n${renderChildOutcome(outcome.output)}`
      : outcome.status === "failed"
        ? `failed: ${renderChildOutcome(outcome.error)}`
        : outcome.status; // cancelled / other terminal

  return (
    `A sub-agent you spawned (childRunId ${childRunId}) finished — it ${detail}. ` +
    "Incorporate this into your answer now. Do not say you will follow up when it finishes; it already has."
  );
}
