import {
  AWAIT_SUB_AGENT_CEILING_MS,
  scheduleSubAgentJoinWakeJob,
} from "./sub-agent-join-wake-queue";
import { subAgentDoneSignalName } from "./sub-agent-metadata";
import {
  readChildRunOutcome,
  shouldResolveWithoutParking,
  type ChildRunOutcome,
} from "./sub-agents";

/**
 * The join protocol: everything a parent must do to take a child sub-agent's
 * outcome, in the one order that cannot strand it.
 *
 * Two sites join a child — the `system.await_sub_agent` tool
 * (`resolveAwaitSubAgent` in `tool-runtime/dispatch`) and the chat-turn finalization
 * guard (`guardSpawnedChildren` in `workflows/finalize-guards`) — and they used
 * to be two hand-written copies of this sequence, kept in step by comments
 * citing each other. `shouldResolveWithoutParking` centralized the *predicate*;
 * this centralizes the *sequence around it*, which is where the dangerous half
 * lives: `findResumableRunIds` never sweeps `waiting`, so a park scheduled
 * without its dead-man timer is a permanently un-wakeable run.
 *
 * {@link JoinChildRunResult} is the enforcement, and {@link ParkSignal} is what
 * makes it enforcement rather than documentation: the park arm is only
 * *constructible* inside this module, on the one branch where
 * `scheduleSubAgentJoinWakeJob` answered `"scheduled"`.
 */
export type JoinChildRunResult =
  /**
   * Hand the caller something to surface now: a terminal child's real result, an
   * ownership/lookup error, an honest still-running note for a child past the
   * wait-ceiling, or the same note when the dead-man timer could not be
   * scheduled (`reason: "join_timer_unavailable"`).
   */
  | { kind: "resolved"; outcome: ChildRunOutcome }
  /** Park the parent on this signal. The dead-man timer is already scheduled. */
  | { kind: "park"; signalName: ParkSignal };

/**
 * A `sub_agent_done` signal name that is *safe to park on* — meaning the dead-man
 * wake for it has already been scheduled.
 *
 * The brand is minted in exactly one place ({@link mintParkSignal}, below the one
 * `scheduled` check), so `{ kind: "park", signalName: subAgentDoneSignalName(id) }`
 * hand-written at a third join site does not type-check. Without it the park arm
 * was structurally constructible by anyone who imported the already-exported
 * name helper, and the only thing standing between that and a permanently
 * un-wakeable parent (`findResumableRunIds` never sweeps `waiting`) was this
 * docstring.
 *
 * What it does *not* cover: a site that ignores this module and parks on a raw
 * `{ kind: "signal", name }` wake condition of its own. The wake condition takes
 * any string by construction — it serves every signal in the system, not just
 * this one. The brand closes the shape that looks like joining a child; use
 * {@link joinChildRun} and there is nothing to remember.
 */
export type ParkSignal = string & { readonly __parkSignal: unique symbol };

/**
 * The single mint. A cast is unavoidable — the brand exists only in the type
 * system — so it is confined here, one line from the check that earns it.
 */
function mintParkSignal(childRunId: string): ParkSignal {
  return subAgentDoneSignalName(childRunId) as ParkSignal;
}

/**
 * The I/O both join sites inject so the protocol can be unit-tested (timer
 * scheduling failure, ceiling expiry, terminal folding) with no DB and no Redis.
 * Production always resolves these to the real implementations.
 */
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

  // Terminal child, an ownership/lookup error, or a child that has outrun the
  // wait-ceiling: there is already something to surface, so never park. This is
  // also what stops a stuck child re-parking forever — once it outruns the
  // ceiling the caller reports it instead of scheduling yet another timer.
  if (shouldResolveWithoutParking(outcome)) return { kind: "resolved", outcome };

  // Still running within the ceiling. Schedule the dead-man wake BEFORE
  // returning a park. The in-band `sub_agent_done` signal is the happy-path
  // waker, but it can be lost (the child finishes in the gap before the executor
  // commits `waiting`), never fire (a cancelled child), or be swallowed by a
  // worker crash — and `findResumableRunIds` never sweeps `waiting`, so any of
  // those strands the parent forever. This timer is the only backstop covering
  // all of them: when it fires the join re-reads the (terminal-by-then) child
  // and resolves inline. It no-ops if the in-band signal already woke the parent.
  const scheduled = await deps.scheduleWake({
    childRunId: args.childRunId,
    parentRunId: args.parentRunId,
    delayMs: AWAIT_SUB_AGENT_CEILING_MS,
  });
  if (scheduled !== "scheduled") {
    // The timer is load-bearing, not best-effort. If it could not be scheduled
    // ("failed" transient queue error, or "disabled" with no queue at all),
    // parking would risk an un-wakeable run — so resolve with the still-running
    // outcome instead and let the turn end honestly.
    console.warn(
      "[sub_agent_join] dead-man wake not scheduled (",
      scheduled,
      ") — refusing to park",
      args.childRunId,
    );
    return { kind: "resolved", outcome: { ...outcome, reason: "join_timer_unavailable" } };
  }
  return { kind: "park", signalName: mintParkSignal(args.childRunId) };
}
