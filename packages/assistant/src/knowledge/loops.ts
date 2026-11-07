import type {
  BriefingLoop,
  LoopEvidenceTier,
  ObjectIdentity,
  TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { loopVerificationRuns } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { desc, eq } from "drizzle-orm";
import {
  deliveryInstantNow,
  objectStateStore,
  type CandidateKey,
  type ObjectState,
} from "@alfred/assistant/connections";
import {
  loopVerifierFor,
  type LoopReadBatch,
  type LoopVerifier,
  type LoopVerifierRead,
} from "@alfred/assistant/connections/verified-pull";
import { findAmbiguous } from "./loop-ambiguity";
import { toLoopItems } from "./loop-items";
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

export interface VerifyLoopsArgs {
  userId: string;
  /** The time of the run. The window ends here. */
  clock: Date;
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
  windowStart: Date;
  /** Stored rows whose payload this build cannot parse. Their mails point to nothing. */
  unreadableRows: number;
}

/** What one thing became in this run. */
export interface ThingOutcome {
  state: ObjectState | null;
  evidence: LoopEvidenceTier;
  /** `true`: a read was due and gave no fact, or the commit failed. */
  readFailed: boolean;
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

  const ambiguous = await findAmbiguous({ userId, clock, things });
  const outcomes = await readAndCommit({ userId, clock, windowStart, things, ambiguous });
  const loops = await toLoopItems(userId, things, outcomes);

  logger.info(
    {
      userId,
      windowStart: windowStart.toISOString(),
      mails: mailRead.mails.length,
      unreadableRows: mailRead.unreadable,
      things: things.length,
      ambiguous: ambiguous.size,
      verdicts: countVerdicts(loops),
    },
    "[loops] verified",
  );

  return { loops, windowStart, unreadableRows: mailRead.unreadable };
}

/** Decision 4: the last committed run, at least 3 days back. The first run reads 30 days. */
async function readWindowStart(userId: string, clock: Date): Promise<Date> {
  const [last] = await db()
    .select({ ranAt: loopVerificationRuns.ranAt })
    .from(loopVerificationRuns)
    .where(eq(loopVerificationRuns.userId, userId))
    .orderBy(desc(loopVerificationRuns.ranAt))
    .limit(1);

  const minimum = clock.getTime() - MIN_WINDOW_MS;

  if (!last) return new Date(clock.getTime() - FIRST_RUN_WINDOW_MS);

  return new Date(Math.min(last.ranAt.getTime(), minimum));
}

/** One read that this run admitted, with its verifier batch and its target id. */
interface PlannedRead {
  thing: LoopThing;
  batch: LoopReadBatch;
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
  windowStart: Date;
  things: readonly LoopThing[];
  ambiguous: ReadonlySet<LoopThing>;
}): Promise<Map<LoopThing, ThingOutcome>> {
  const batches = new Map<LoopVerifier, LoopReadBatch>();
  const planned: PlannedRead[] = [];
  // The distinct targets of each batch. Two things can name one target, so one read serves both.
  const idsByBatch = new Map<LoopReadBatch, Set<string>>();
  let liveReads = 0;

  const batchOf = (verifier: LoopVerifier): LoopReadBatch => {
    const batch = batches.get(verifier) ?? verifier.batch();

    batches.set(verifier, batch);

    return batch;
  };

  // `things` is newest evidence first, so the cap keeps the newest.
  for (const thing of args.things) {
    if (!args.ambiguous.has(thing)) continue;

    const verifier = thing.state
      ? loopVerifierFor(thing.state.provider, thing.state.kind)
      : (thing.keyRead?.verifier ?? null);

    if (!verifier) continue;

    const batch = batchOf(verifier);

    const targetId = thing.state
      ? batch.planState(thing.state)
      : thing.keyRead
        ? batch.planKey(thing.keyRead.key)
        : null;

    if (targetId === null) continue;

    const ids = idsByBatch.get(batch) ?? new Set<string>();

    if (!ids.has(targetId)) {
      if (liveReads >= MAX_LIVE_READS) continue;

      ids.add(targetId);
      liveReads += 1;
    }

    idsByBatch.set(batch, ids);
    planned.push({ thing, batch, targetId });
  }

  const readsByBatch = new Map<LoopReadBatch, ReadonlyMap<string, LoopVerifierRead>>(
    await Promise.all(
      [...idsByBatch].map(
        async ([batch, ids]) => [batch, await batch.read(args.userId, [...ids])] as const,
      ),
    ),
  );

  const readByThing = new Map<LoopThing, LoopVerifierRead>();
  const facts = new Map<string, LoopVerifierRead>();

  for (const { thing, batch, targetId } of planned) {
    const read = readsByBatch.get(batch)?.get(targetId);

    if (!read) continue;

    readByThing.set(thing, read);
    facts.set(identityRef(read.identity), read);
  }

  const outcomes = new Map<LoopThing, ThingOutcome>();
  let committed = true;

  try {
    const deliveredAt = deliveryInstantNow();

    await objectStateStore.applyEvents({
      userId: args.userId,
      facts: [...facts.values()].map((read) => ({ event: read.fact, deliveredAt })),
      inTransaction: async (tx) => {
        await tx.insert(loopVerificationRuns).values({
          userId: args.userId,
          ranAt: args.clock,
          windowStart: args.windowStart,
          things: args.things.length,
          liveReads,
          facts: facts.size,
        });
      },
    });
  } catch (err) {
    committed = false;
    logger.warn({ err, userId: args.userId }, "[loops] commit failed; read things stay unverified");
  }

  // The rows after the fold. The recency guard can refuse an older fact, so the row is the truth.
  const after = new Map<string, ObjectState | null>();

  if (committed) {
    await Promise.all(
      [...facts.entries()].map(async ([ref, read]) => {
        after.set(ref, await objectStateStore.getByIdentity(args.userId, read.identity));
      }),
    );
  }

  for (const thing of args.things) {
    if (!args.ambiguous.has(thing)) {
      outcomes.set(thing, { state: thing.state, evidence: "stored_state", readFailed: false });
      continue;
    }

    const read = readByThing.get(thing);
    const state = read ? after.get(identityRef(read.identity)) : undefined;

    outcomes.set(
      thing,
      state
        ? { state, evidence: "live_read", readFailed: false }
        : { state: thing.state, evidence: "stored_state", readFailed: true },
    );
  }

  return outcomes;
}

function identityRef(identity: ObjectIdentity): string {
  return JSON.stringify([identity.provider, identity.kind, identity.externalId]);
}

function countVerdicts(loops: readonly BriefingLoop[]) {
  const counts = { open: 0, closed: 0, unverified: 0 } satisfies Record<
    BriefingLoop["verdict"],
    number
  >;

  for (const loop of loops) counts[loop.verdict] += 1;

  return counts;
}
