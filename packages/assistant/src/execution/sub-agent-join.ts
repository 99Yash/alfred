import type { WakeCondition } from "@alfred/contracts";
import type { SafeToParkWake } from "@alfred/assistant/tool-runtime";

import {
  AWAIT_SUB_AGENT_CEILING_MS,
  scheduleSubAgentJoinWakeJob,
} from "./sub-agent-join-wake-queue";
import { subAgentDoneSignalName } from "./sub-agent-metadata";
import {
  readChildRunOutcome,
  shouldResolveWithoutParking,
  type ChildRunOutcome,
  type SpawnedChildRun,
} from "./sub-agents";

/**
 * How a parent joins a child sub-agent. The sweep never resumes `waiting` runs, so a park
 * needs a backstop. Only this module can build the `park` arm, and its wake carries the
 * deadline that the join reconciler reads from Postgres.
 */
export type JoinChildRunResult =
  | { kind: "resolved"; outcome: ChildRunOutcome }
  | { kind: "park"; wake: ParkWake };

/**
 * A `sub_agent_done` signal wake with a persisted deadline. A raw signal wake condition
 * can still bypass it, so join through {@link joinChildRun} or {@link joinChildOutcome}.
 */
export type ParkWake = SafeToParkWake;

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
export interface JoinChildRunDeps {
  readOutcome: typeof readChildRunOutcome;
  scheduleWake: typeof scheduleSubAgentJoinWakeJob;
}

const defaultJoinChildRunDeps: JoinChildRunDeps = {
  readOutcome: readChildRunOutcome,
  scheduleWake: scheduleSubAgentJoinWakeJob,
};

export async function joinChildRun(
  args: { parentRunId: string; userId: string; childRunId: string },
  deps: JoinChildRunDeps = defaultJoinChildRunDeps,
): Promise<JoinChildRunResult> {
  const outcome = await deps.readOutcome(args);

  return await joinChildOutcome(
    { id: args.childRunId, parentRunId: args.parentRunId, outcome },
    deps,
  );
}

/**
 * Decide park or fold from one child value. The value carries the row's id, the parent it was
 * read under, and the outcome of that row (`not_found` too, from `joinChildRun`), so a caller
 * cannot pass child A's outcome next to child B's id as free arguments. A hand-built or spread
 * `SpawnedChildRun` literal still compiles: only `listSpawnedChildRuns` and `joinChildRun` bind
 * the id and parent to the row they checked.
 */
export async function joinChildOutcome(
  child: SpawnedChildRun,
  deps: Pick<JoinChildRunDeps, "scheduleWake">,
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
