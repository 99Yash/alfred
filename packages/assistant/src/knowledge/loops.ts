import type { BriefingLoop, LoopEvidenceTier, TriageCategory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { loopVerificationRuns, type NewLoopVerificationRun } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { desc, eq } from "drizzle-orm";
import {
  objectStateStore,
  type CandidateKey,
  type ObjectState,
} from "@alfred/assistant/connections";
import {
  loopVerifierFor,
  type LoopReadSource,
  type LoopVerifier,
  type LoopVerifierRead,
} from "@alfred/assistant/connections/verified-pull";
import { findAmbiguous } from "./loop-ambiguity";
import { toLoopItems, type ClosedLoopItem } from "./loop-items";
import {
  collectThings,
  readLoopMails,
  readOpenTodoIdentities,
  withExtraMails,
  type LoopThing,
} from "./loop-set";

/**
 * `verifyLoops` (ADR-0120 decisions 4 to 8). A loop is a thing, an `integration_objects` row, that
 * a priority mail or an open todo points to. The stored state is the verdict. A live read runs
 * only when the stored state is ambiguous. All reads run first, and then one transaction folds
 * every fact and records the run. The result has one item for each loop, with the verdict `open`,
 * `closed`, or `unverified`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window of the first run (decision 4). */
const FIRST_RUN_WINDOW_MS = 30 * DAY_MS;

/** Each later run reads at least this far back, so a gap in the briefings does not lose a loop. */
const MIN_WINDOW_MS = 3 * DAY_MS;

/**
 * The live reads of one run (decision 5). It replaces the three caps of 5 of the old passes. The
 * things with the newest evidence come first. A thing over the cap is `unverified`.
 */
const MAX_LIVE_READS = 10;

/**
 * The bound on all live reads of one run. A read that it stops proves nothing, so its thing is
 * `unverified`. The commit is outside the bound.
 */
const LIVE_READS_DEADLINE_MS = 30_000;

export interface VerifyLoopsArgs {
  userId: string;
  /** The time of the run. The window ends here. */
  clock: Date;
  /** The caller's abort. It stops the live reads, and an aborted run records nothing. */
  signal: AbortSignal;
  /**
   * Mails that a read before this run pointed at a thing: the approved MCP health read (ADR-0120
   * slice 2). Such a mail often names no key, so triage stored no row for it.
   */
  extraMails?: readonly ExtraLoopMail[] | undefined;
}

/** A mail and the keys that a read before this run gave it. */
export interface ExtraLoopMail {
  documentId: string;
  occurredAt: Date;
  /** The current triage verdict. Only a loop category counts, as for a stored row. */
  category: TriageCategory;
  keys: readonly CandidateKey<"about">[];
}

export interface VerifyLoopsResult {
  /** One item for each loop, newest evidence first. */
  loops: BriefingLoop[];
  /**
   * The mails that the gather drops: each mail whose every thing is `closed`, with the item of its
   * first thing. An item caps its mails at 20, so the drop reads this map, not `loops`.
   */
  closedMails: ReadonlyMap<string, ClosedLoopItem>;
}

/** Why no fact of this run backs a thing whose stored state is ambiguous. */
type UnverifiedReason =
  /** The kind has no live reader. */
  | "no_reader"
  /** The reader cannot name a target for the row or the key. */
  | "no_target"
  /** The cap of the run admitted no read for the thing. */
  | "over_cap"
  /** The read faulted, or it proved no state. */
  | "read_failed"
  /** The commit transaction failed. */
  | "commit_failed"
  /** The commit kept no row for the fact. */
  | "fact_refused";

/** What one thing became in this run. */
export interface ThingOutcome {
  state: ObjectState | null;
  evidence: LoopEvidenceTier;
  /** `null`: the state is the verdict. Else the reason that the thing is `unverified`. */
  unverified: UnverifiedReason | null;
}

export async function verifyLoops(args: VerifyLoopsArgs): Promise<VerifyLoopsResult> {
  const { userId, clock } = args;
  const windowStart = await readWindowStart(userId, clock);

  const [mailRead, todoIdentities] = await Promise.all([
    readLoopMails(userId, windowStart, clock),
    readOpenTodoIdentities(userId),
  ]);

  const things = await collectThings({
    userId,
    mails: withExtraMails(mailRead.mails, args.extraMails ?? []),
    todoIdentities,
  });

  const { ambiguous, readThisRun } = await findAmbiguous({ userId, clock, things });

  const outcomes = await readAndCommit({
    userId,
    clock,
    signal: args.signal,
    windowStart,
    things,
    ambiguous,
    readThisRun,
  });

  const { loops, closedMails } = await toLoopItems({ userId, things, outcomes, windowStart });

  logger.info(
    {
      userId,
      windowStart: windowStart.toISOString(),
      mails: mailRead.mails.length,
      unreadableRows: mailRead.unreadable,
      things: things.length,
      ambiguous: ambiguous.size,
      readThisRun: readThisRun.size,
      verdicts: countVerdicts(loops),
      unverified: countUnverified(outcomes),
    },
    "[loops] verified",
  );

  return { loops, closedMails };
}

/**
 * Decision 4: the last committed run, at least 3 days back. The first run reads 30 days. A run
 * that left a mailed thing `unverified` holds the next window at the oldest mail of that thing, so
 * the thing stays in the set. No window starts more than 30 days back.
 */
async function readWindowStart(userId: string, clock: Date): Promise<Date> {
  const [last] = await db()
    .select({
      ranAt: loopVerificationRuns.ranAt,
      oldestUnverifiedMailAt: loopVerificationRuns.oldestUnverifiedMailAt,
    })
    .from(loopVerificationRuns)
    .where(eq(loopVerificationRuns.userId, userId))
    .orderBy(desc(loopVerificationRuns.ranAt))
    .limit(1);

  const earliest = clock.getTime() - FIRST_RUN_WINDOW_MS;

  if (!last) return new Date(earliest);

  const start = Math.min(
    last.ranAt.getTime(),
    last.oldestUnverifiedMailAt?.getTime() ?? Number.POSITIVE_INFINITY,
    clock.getTime() - MIN_WINDOW_MS,
  );

  return new Date(Math.max(start, earliest));
}

/** One read that this run admitted, with its verifier and its target id. */
interface PlannedRead {
  thing: LoopThing;
  verifier: LoopVerifier;
  targetId: string;
}

/**
 * Decision 7: read all, then one commit. The admitted reads run first, outside any transaction.
 * Then one transaction folds every fact and records the run. A commit fault makes each read thing
 * `unverified`, and the run has no row, so the next run reads the same window again.
 */
async function readAndCommit(args: {
  userId: string;
  clock: Date;
  signal: AbortSignal;
  windowStart: Date;
  things: readonly LoopThing[];
  ambiguous: ReadonlySet<LoopThing>;
  readThisRun: ReadonlySet<LoopThing>;
}): Promise<Map<LoopThing, ThingOutcome>> {
  const outcomes = new Map<LoopThing, ThingOutcome>();
  const planned: PlannedRead[] = [];
  // The distinct targets of each verifier. Two things can name one target, so one read serves both.
  const sourcesByVerifier = new Map<LoopVerifier, Map<string, LoopReadSource>>();
  let liveReads = 0;

  const unverified = (thing: LoopThing, reason: UnverifiedReason): void => {
    outcomes.set(thing, { state: thing.state, evidence: "stored_state", unverified: reason });
  };

  // `things` is newest evidence first, so the cap keeps the newest.
  for (const thing of args.things) {
    if (args.readThisRun.has(thing)) {
      outcomes.set(thing, { state: thing.state, evidence: "live_read", unverified: null });
      continue;
    }

    if (!args.ambiguous.has(thing)) {
      outcomes.set(thing, { state: thing.state, evidence: "stored_state", unverified: null });
      continue;
    }

    const verifier = thing.state
      ? loopVerifierFor(thing.state.provider, thing.state.kind)
      : (thing.keyRead?.verifier ?? null);

    if (!verifier) {
      unverified(thing, "no_reader");
      continue;
    }

    const source: LoopReadSource | null = thing.state
      ? { state: thing.state }
      : thing.keyRead
        ? { key: thing.keyRead.key }
        : null;

    const targetId = source ? verifier.targetId(source) : null;

    if (source === null || targetId === null) {
      unverified(thing, "no_target");
      continue;
    }

    const sources = sourcesByVerifier.get(verifier) ?? new Map<string, LoopReadSource>();

    if (!sources.has(targetId)) {
      if (liveReads >= MAX_LIVE_READS) {
        unverified(thing, "over_cap");
        continue;
      }

      sources.set(targetId, source);
      liveReads += 1;
    }

    sourcesByVerifier.set(verifier, sources);
    planned.push({ thing, verifier, targetId });
  }

  // `read` never throws, so no sibling stops early. The caller's abort and the deadline stop all.
  const readSignal = AbortSignal.any([args.signal, AbortSignal.timeout(LIVE_READS_DEADLINE_MS)]);

  const readsByVerifier = new Map<LoopVerifier, ReadonlyMap<string, LoopVerifierRead>>(
    await Promise.all(
      [...sourcesByVerifier].map(
        async ([verifier, sources]) =>
          [verifier, await verifier.read(args.userId, [...sources.values()], readSignal)] as const,
      ),
    ),
  );

  // The caller gave up on the run, so it records no run and folds no fact.
  args.signal.throwIfAborted();

  const readByThing = new Map<LoopThing, LoopVerifierRead>();

  for (const { thing, verifier, targetId } of planned) {
    const read = readsByVerifier.get(verifier)?.get(targetId);

    if (read) {
      readByThing.set(thing, read);
    } else {
      unverified(thing, "read_failed");
    }
  }

  // One fact for each target. Two things that name one target share one read.
  const facts = new Set(readByThing.values());
  let committed = true;

  try {
    await objectStateStore.applyEvents({
      userId: args.userId,
      // Each fact has the instant of its own read, not of the commit (decision 7).
      facts: [...facts].map((read) => ({ event: read.fact, deliveredAt: read.readAt })),
      inTransaction: async (tx) => {
        await tx.insert(loopVerificationRuns).values({
          userId: args.userId,
          ranAt: args.clock,
          windowStart: args.windowStart,
          thingCount: args.things.length,
          liveReadCount: liveReads,
          factCount: facts.size,
          ...unverifiedBeforeCommit(outcomes),
        });
      },
    });
  } catch (err) {
    committed = false;
    logger.warn({ err, userId: args.userId }, "[loops] commit failed; read things stay unverified");
  }

  // The rows after the fold, keyed by each read's identity. The guards can refuse a fact, so the
  // row is the truth.
  const after = committed
    ? await objectStateStore.getByIdentities(
        args.userId,
        [...facts].map((read) => read.identity),
      )
    : null;

  for (const [thing, read] of readByThing) {
    if (!committed) {
      unverified(thing, "commit_failed");
      continue;
    }

    const state = after?.get(read.identity) ?? null;

    if (state === null) {
      unverified(thing, "fact_refused");
      continue;
    }

    // The recency or absorbing guard refused the fact, so a newer stored fact gives the verdict.
    // Only a read whose state the row holds is a live confirmation.
    const evidence = state.nativeState === read.nativeState ? "live_read" : "stored_state";

    outcomes.set(thing, { state, evidence, unverified: null });
  }

  return outcomes;
}

/**
 * The things that no read of this run backs, as the run row records them. A fact that the commit
 * refuses (`fact_refused`) is known only after the commit, so it is not in the count, and its thing
 * does not hold the window. Each verifier gives only a state that the store folds, so that case is
 * not expected.
 */
function unverifiedBeforeCommit(
  outcomes: ReadonlyMap<LoopThing, ThingOutcome>,
): Pick<NewLoopVerificationRun, "unverifiedCount" | "oldestUnverifiedMailAt"> {
  let unverifiedCount = 0;
  let oldestUnverifiedMailAt: Date | null = null;

  for (const [thing, { unverified }] of outcomes) {
    if (unverified === null) continue;

    unverifiedCount += 1;

    // A thing with no mail comes from an open todo, and the todo keeps it in the set.
    if (
      thing.oldestMailAt !== null &&
      (oldestUnverifiedMailAt === null || thing.oldestMailAt < oldestUnverifiedMailAt)
    ) {
      oldestUnverifiedMailAt = thing.oldestMailAt;
    }
  }

  return { unverifiedCount, oldestUnverifiedMailAt };
}

/** The reasons of the `unverified` things, for the run log. */
function countUnverified(outcomes: ReadonlyMap<LoopThing, ThingOutcome>) {
  const counts = {
    no_reader: 0,
    no_target: 0,
    over_cap: 0,
    read_failed: 0,
    commit_failed: 0,
    fact_refused: 0,
  } satisfies Record<UnverifiedReason, number>;

  for (const { unverified } of outcomes.values()) {
    if (unverified !== null) counts[unverified] += 1;
  }

  return counts;
}

function countVerdicts(loops: readonly BriefingLoop[]) {
  const counts = { open: 0, closed: 0, unverified: 0 } satisfies Record<
    BriefingLoop["verdict"],
    number
  >;

  for (const loop of loops) counts[loop.verdict] += 1;

  return counts;
}
