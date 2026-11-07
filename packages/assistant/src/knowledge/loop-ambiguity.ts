import { isAbsorbingState, type ObjectStateProvider } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import {
  readActivityCoverage,
  type ActivityCoverage,
  type ObjectState,
} from "@alfred/assistant/connections";
import { factTime, type LoopThing } from "./loop-set";
import { readObservationFamilyHeads } from "./observations";

/** The ambiguity rule of `verifyLoops` (ADR-0120 decision 5): which things need a live read. */

/** The providers whose deliveries an activity source records, so a coverage read can see a gap. */
const COVERED_PROVIDERS: ReadonlySet<ObjectStateProvider> = new Set(["github"]);

/**
 * Decision 5: the things whose stored state is ambiguous. An absorbing state is never ambiguous: no
 * later fact can move it. The three cases: no row, a mail newer than the fact, a blind source.
 */
export async function findAmbiguous(args: {
  userId: string;
  clock: Date;
  things: readonly LoopThing[];
}): Promise<Set<LoopThing>> {
  const ambiguous = new Set<LoopThing>();
  const blindCheck: { thing: LoopThing; state: ObjectState; at: Date }[] = [];

  for (const thing of args.things) {
    const { state } = thing;

    // Case 3.
    if (state === null) {
      ambiguous.add(thing);
      continue;
    }

    if (isAbsorbingState(state.provider, state.kind, state.stateCategory)) continue;

    const at = factTime(state);

    // Case 1. A state with no time cannot be older than nothing, so it is read.
    if (at === null || (thing.newestMailAt !== null && thing.newestMailAt > at)) {
      ambiguous.add(thing);
      continue;
    }

    // A fold of this run (the MCP health read just before it) leaves no time for a gap.
    if (state.stateDeliveredAt !== null && state.stateDeliveredAt >= args.clock) continue;

    // Case 2, for a provider with no activity source: nothing can show that it was not blind.
    if (!COVERED_PROVIDERS.has(state.provider)) {
      ambiguous.add(thing);
      continue;
    }

    blindCheck.push({ thing, state, at });
  }

  if (blindCheck.length === 0) return ambiguous;

  const oldest = blindCheck.reduce((min, { at }) => (at < min ? at : min), args.clock);
  const coverage = await readCoverage(args.userId, { start: oldest, end: args.clock }, args.clock);

  for (const { thing, state, at } of blindCheck) {
    if (isBlindAfter(coverage, state.provider, at)) ambiguous.add(thing);
  }

  return ambiguous;
}

/** The coverage entries, or `null` when the read faulted: then each source counts as blind. */
async function readCoverage(
  userId: string,
  window: { start: Date; end: Date },
  clock: Date,
): Promise<readonly ActivityCoverage[] | null> {
  try {
    const read = await readActivityCoverage({
      userId,
      window,
      clock,
      readFamilyHeads: readObservationFamilyHeads,
    });

    return read.entries;
  } catch (err) {
    logger.warn({ err, userId }, "[loops] coverage read failed; covered things count as blind");

    return null;
  }
}

/**
 * Case 2: the coverage of the source is not `live` between the fact and now. A silent gap that
 * ended before the fact does not matter. Every other failure makes the whole window blind.
 */
function isBlindAfter(
  coverage: readonly ActivityCoverage[] | null,
  provider: ObjectStateProvider,
  at: Date,
): boolean {
  const entry = coverage?.find(
    (candidate) => candidate.source.kind === "integration" && candidate.source.slug === provider,
  );

  if (!entry) return true;

  if (entry.state === "live") return false;

  const { failure } = entry;

  if (failure.cause !== "silent") return true;

  if ("gap" in failure) return true;

  return failure.gaps.some((gap) => gap.to > at);
}
