import {
  assertNever,
  INTEGRATIONS,
  isCatalogSlug,
  sourceIdentitySchema,
  typedKeys,
  type ActivityObservationSource,
  type CredentialRowsByProvider,
  type SourceIdentity,
  type SourceRoutes,
} from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { readIntegrationAvailability } from "../availability";
import type { EventDeliveryFailure } from "../ingress/descriptor";
import { readInboundTriggerHealth } from "../ingress/health";
import { builtInProviderForEndpoint } from "../mcp/built-ins";
import { listOwnedConnections } from "../mcp/persistence";
import type { GithubMergedReadOutcome } from "../verified-pull/github-merged-read";
import { readGithubActivityDocumentsBetween } from "./documents";
import { githubActOf, isGithubActRecorded, type GithubFamilyHead } from "./github-activity";

/**
 * The coverage of each connected source for one window (ADR-0118 decision 4, in the ADR-0117
 * vocabulary). A reader that gets no events from an `unavailable` source must not say that
 * nothing happened. Every connected source gets one entry: a credential provider, a built-in MCP
 * server (named by its registry slug), and a server that the user added. A source with a reducer
 * also gets one when its documents reach into the window, so a deleted credential does not hide
 * the coverage of the time when it was connected.
 *
 * A source with no activity reducer is `unavailable` with the cause `no_record`, whatever its
 * route: a `tools_only` or `live` source records nothing, and an `ingest` source without a reducer
 * stores documents but no activity rows.
 *
 * A source with a reducer is `unavailable` when one of these is true:
 * - Connection state, only for a window that reaches the present. The current credential says
 *   nothing about a past day.
 * - Silence. A gap between two deliveries, or between the last delivery and the window's end, is
 *   longer than the source's bound. The gap can be anywhere in the window, so a day where the
 *   deliveries start again after an outage is still `unavailable`. This is the only delivery signal
 *   for a past window: a credential row that a reconnect deleted leaves no record.
 * - An incomplete record. A delivery arrived, but the record does not hold its act: the activity
 *   writer failed all its attempts, or the delivery came before the writer existed. The document
 *   exists, so the silence check cannot see this. The receipt status is not the evidence: a
 *   receipt from before the writer is `completed`, and `ingress.deliver` does not run a completed
 *   receipt again. The check reduces each document of the window and looks for the act's family
 *   head. The replay repairs the record.
 *
 * The checks run in this order, so a record that misses an act is never `live`: the connection
 * state, a gap that reaches the present, the incomplete record, then a past gap.
 *
 * Only a gap that reaches the present tells the user to connect. A past gap cannot be repaired
 * now, so its recovery is `none`: the reader still must not call the window quiet.
 *
 * The record alone cannot tell a silent source from a broken one. `settleActivityCoverage` gives
 * the verdict after a provider read that does not depend on a delivery, so each reader of the
 * record gets the same verdict.
 */

/** How long each activity source can be silent before Alfred stops trusting a quiet window. */
const ACTIVITY_SOURCES = {
  /**
   * 24 hours. From 2026-10-10 to 2026-11-01 the longest gap between two GitHub deliveries was
   * 14 h 41 min, except the 6-day outage from 2026-10-22. A day with no work at all can still read
   * as `unavailable`; that is the cost of not reading a dead source as a quiet one.
   */
  github: {
    silenceBoundMs: 24 * 60 * 60 * 1000,
    countUnrecordedActs: countUnrecordedGithubActs,
    gapProof: githubGapProof,
  },
} as const satisfies {
  readonly [S in ActivityObservationSource]: {
    silenceBoundMs: number;
    countUnrecordedActs: (args: UnrecordedActsArgs) => Promise<number>;
    gapProof: (evidence: SilenceEvidence[S], gap: DeliveryGap) => GapProof;
  };
};

/**
 * The provider read of each source with a reducer that settles a silence. The read must not depend
 * on a delivery. A new activity source does not compile until it names its read here.
 */
interface SilenceEvidence {
  readonly github: GithubMergedReadOutcome;
}

/** What a provider read proves about a delivery gap. `finding` is a clause for the reader. */
type GapProof =
  /** The read holds acts in the gap whose deliveries did not arrive. */
  | { readonly kind: "missed"; readonly finding: string }
  /** The read is complete, and it holds no act in the gap. */
  | { readonly kind: "none"; readonly finding: string }
  /** The read did not complete, or it holds only a part of its acts. */
  | { readonly kind: "unknown" };

/** The sources with an activity reducer. Each one is also the `documents.source` of its deliveries. */
export const ACTIVITY_SOURCE_SLUGS = typedKeys(ACTIVITY_SOURCES);

function activitySourceOf(source: SourceIdentity): ActivityObservationSource | null {
  if (source.kind !== "integration") return null;

  return ACTIVITY_SOURCE_SLUGS.find((slug) => slug === source.slug) ?? null;
}

/**
 * A delivery younger than this can still be in the queue: `ingress.deliver` makes five attempts
 * with an exponential 5 s backoff, about 75 s in total. A reader that checks the record against a
 * provider read gives an act the same time to arrive.
 */
export const ACTIVITY_DELIVERY_GRACE_MS = 15 * 60 * 1000;

/** The window that the reader asks about: `start` inclusive, `end` exclusive. */
export interface ActivityWindow {
  readonly start: Date;
  readonly end: Date;
}

/** Two arrival times. `from` is `null` when no delivery came before the gap. */
interface DeliveryGap {
  readonly from: Date | null;
  readonly to: Date;
  /**
   * An act before this time had the grace time to arrive before `to`. A provider read counts only
   * such an act as missed. The grace is off one time: `to` minus the grace when a delivery ends the
   * gap, and the settled end of the read when the read's end closes the gap.
   */
  readonly settledBy: Date;
}

/**
 * The delivery gaps longer than the source's bound. `reachesPresent` is true when no delivery came
 * from `gap.from` to now. Only then can a reconnect repair the gap, so only then is the recovery
 * `connect`. Such a gap comes first, so the past gaps of that window do not matter.
 */
type SilentFailure = {
  readonly cause: "silent";
  /** The text for the reader. `settleActivityCoverage` adds what the provider read proves. */
  readonly reason: string;
} & (
  | {
      readonly reachesPresent: true;
      readonly gap: DeliveryGap;
      readonly recovery: {
        readonly kind: "connect";
        readonly integration: ActivityObservationSource;
      };
    }
  | {
      readonly reachesPresent: false;
      /** Each gap of the window that is longer than the bound, in time order. */
      readonly gaps: readonly [DeliveryGap, ...DeliveryGap[]];
      readonly recovery: { readonly kind: "none" };
    }
);

/** The record of the window misses acts or holds rows that this build cannot read. */
interface RecordIncompleteFailure {
  readonly cause: "record_incomplete";
  readonly reason: string;
  /** The acts of the window's deliveries that the record does not hold. Only the replay repairs them. */
  readonly acts: number;
  /** The rows of the window whose payload this build cannot parse: a writer and this build disagree. */
  readonly unreadable: number;
  readonly recovery: { readonly kind: "none" };
}

/** The source has no activity reducer, so the record has no events from it. */
interface NoRecordFailure {
  readonly cause: "no_record";
  readonly reason: string;
  readonly routes: SourceRoutes;
  readonly recovery: { readonly kind: "none" };
}

export type ActivityCoverage =
  | { readonly source: SourceIdentity; readonly state: "live" }
  | {
      readonly source: SourceIdentity;
      readonly state: "unavailable";
      readonly failure:
        | SilentFailure
        | RecordIncompleteFailure
        | NoRecordFailure
        | Omit<EventDeliveryFailure, "healthy">;
    };

/** The routes of a server that the user added. The owner declares nothing yet (ADR-0118 decision 3). */
const CUSTOM_MCP_ROUTES: SourceRoutes = ["tools_only"];

/**
 * The live head of each family in `familyKeys`. `knowledge` owns the observation tables, so the
 * caller passes its reader in.
 */
export type ReadFamilyHeads = (
  userId: string,
  familyKeys: readonly string[],
) => Promise<ReadonlyMap<string, GithubFamilyHead>>;

interface UnrecordedActsArgs {
  readonly userId: string;
  readonly start: Date;
  readonly end: Date;
  readonly readFamilyHeads: ReadFamilyHeads;
}

/**
 * How long after a window's end a read still counts as the present. One hour is much longer than
 * the time from a run's frozen watermark to its gather, and much shorter than the time between two
 * briefing slots.
 */
const WATERMARK_PRESENT_MS = 60 * 60 * 1000;

/**
 * The "now" of a coverage read. A run freezes its watermark a little before it reads, so a window
 * that ends at the watermark must still read as one that reaches the present. If not, the coverage
 * skips the delivery health and cannot ask the user to reconnect. A window that ends after the
 * clock (the local end of the day) is measured to the clock. A window that ended more than
 * `WATERMARK_PRESENT_MS` ago, for example a gather that ran again much later, is a past window:
 * the connection state of today says nothing about it.
 */
function presentOf(window: ActivityWindow, clock: Date): Date {
  const behind = clock.getTime() - window.end.getTime();

  return behind >= 0 && behind <= WATERMARK_PRESENT_MS ? window.end : clock;
}

/**
 * The coverage of every connected source for `window`. `clock` is the time of the read. A caller
 * with a frozen watermark gives it as `window.end`, and this read decides if the window reaches the
 * present (`presentOf`).
 */
export async function readActivityCoverage(args: {
  userId: string;
  window: ActivityWindow;
  clock: Date;
  readFamilyHeads: ReadFamilyHeads;
}): Promise<ActivityCoverage[]> {
  const { userId, window, readFamilyHeads } = args;
  const now = presentOf(window, args.clock);

  const [availability, connections, recordedHistory] = await Promise.all([
    readIntegrationAvailability(userId),
    listOwnedConnections(userId),
    sourcesWithHistory(userId, window.end),
  ]);

  const sources = new Map<string, SourceIdentity>();

  const add = (source: SourceIdentity): void => {
    sources.set(source.kind === "integration" ? source.slug : source.serverId, source);
  };

  for (const [slug, entry] of availability.integrations) {
    if (entry.health !== null) add({ kind: "integration", slug });
  }

  for (const connection of connections) {
    if (connection.status === "disconnected") continue;

    const provider = builtInProviderForEndpoint(connection.server.endpointUrl);

    const source = sourceIdentitySchema.safeParse(
      provider
        ? { kind: "integration", slug: provider }
        : { kind: "custom_mcp", serverId: connection.serverId },
    );

    if (source.success) add(source.data);
  }

  for (const slug of recordedHistory) add({ kind: "integration", slug });

  return Promise.all(
    [...sources.values()].map(async (source) => {
      const recorded = activitySourceOf(source);

      return recorded
        ? recordedSourceCoverage({
            userId,
            window,
            now,
            source,
            recorded,
            rows: availability.providers,
            readFamilyHeads,
          })
        : noRecordCoverage(source);
    }),
  );
}

function noRecordCoverage(source: SourceIdentity): ActivityCoverage {
  // Only a provider entry declares routes. A built-in MCP server resolves to one.
  const routes =
    source.kind === "integration" && isCatalogSlug(source.slug)
      ? INTEGRATIONS[source.slug].sourceRoutes
      : CUSTOM_MCP_ROUTES;

  return {
    source,
    state: "unavailable",
    failure: {
      cause: "no_record",
      reason: "no activity reducer records this source's events",
      routes,
      recovery: { kind: "none" },
    },
  };
}

/**
 * The sources with a reducer that have a document from before `end`. Their history stays after the
 * last credential is deleted.
 */
async function sourcesWithHistory(userId: string, end: Date): Promise<ActivityObservationSource[]> {
  const found = await Promise.all(
    ACTIVITY_SOURCE_SLUGS.map(async (slug) => {
      const [row] = await db()
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.source, slug),
            lt(documents.authoredAt, end),
          ),
        )
        .limit(1);

      return row ? [slug] : [];
    }),
  );

  return found.flat();
}

async function recordedSourceCoverage(args: {
  userId: string;
  window: ActivityWindow;
  now: Date;
  source: SourceIdentity;
  recorded: ActivityObservationSource;
  rows: CredentialRowsByProvider;
  readFamilyHeads: ReadFamilyHeads;
}): Promise<ActivityCoverage> {
  const { userId, window, now, source, recorded, rows, readFamilyHeads } = args;
  const windowReachesPresent = window.end.getTime() >= now.getTime();

  if (windowReachesPresent) {
    const health = (await readInboundTriggerHealth(userId, rows))[recorded];

    if (!health.healthy) {
      const { healthy: _healthy, ...failure } = health;

      return { source, state: "unavailable", failure };
    }
  }

  // The reader puts an act in the window when its delivery arrived in `[start - G, end - G)`
  // (`readActivityEvents`). A past window checks the same arrivals, so one window checks each
  // arrival. A window that reaches the present measures the silence to now, so the arrivals in
  // `[now - G, now)` also close a gap here, and the next window checks them again.
  const from = beforeGrace(window.start);

  // An open window is measured to now: the time after the last delivery is blind time too.
  const until = windowReachesPresent ? now : beforeGrace(window.end);

  // A delivery inside the grace time can still be in the queue, so its act does not count yet.
  const settled = beforeGrace(windowReachesPresent ? now : window.end);

  const { silenceBoundMs } = ACTIVITY_SOURCES[recorded];

  const [silentGaps, unrecorded] = await Promise.all([
    silentDeliveryGaps({ userId, source: recorded, start: from, until, silenceBoundMs }),
    settled.getTime() > from.getTime()
      ? ACTIVITY_SOURCES[recorded].countUnrecordedActs({
          userId,
          start: from,
          end: settled,
          readFamilyHeads,
        })
      : 0,
  ]);

  const gaps = silentGaps.map(
    (gap): DeliveryGap => ({
      ...gap,
      // The end of the read closes this gap, and `settled` already takes the grace off that end.
      settledBy: gap.to.getTime() === until.getTime() ? settled : beforeGrace(gap.to),
    }),
  );

  // A gap to now is not live after any proof, and its reconnect row matters most. It comes before
  // every other check, so a longer past gap cannot hide it.
  const gapToNow = windowReachesPresent
    ? gaps.find((gap) => gap.to.getTime() === until.getTime())
    : undefined;

  if (gapToNow) {
    return silentCoverage(source, {
      cause: "silent",
      reason: `${gapSentence(recorded, gapToNow, true)}.`,
      gap: gapToNow,
      reachesPresent: true,
      recovery: { kind: "connect", integration: recorded },
    });
  }

  // Before a past gap: a provider read can prove that a past gap held no act, and that proof must
  // not hide a known hole in the record.
  if (unrecorded > 0) return recordIncomplete(source, recorded, unrecorded, 0);

  const [first, ...rest] = gaps;

  if (first) {
    return silentCoverage(source, {
      cause: "silent",
      reason: withOtherGaps(`${gapSentence(recorded, first, false)}.`, rest.length),
      gaps: [first, ...rest],
      reachesPresent: false,
      recovery: { kind: "none" },
    });
  }

  return { source, state: "live" };
}

/** `sentence` names one gap. This adds the number of the other gaps of the window. */
function withOtherGaps(sentence: string, others: number): string {
  if (others === 0) return sentence;

  return `${sentence} The window has ${others} other ${others === 1 ? "gap" : "gaps"} of this kind.`;
}

/** The time `ACTIVITY_DELIVERY_GRACE_MS` before `at`. */
function beforeGrace(at: Date): Date {
  return new Date(at.getTime() - ACTIVITY_DELIVERY_GRACE_MS);
}

function silentCoverage(source: SourceIdentity, failure: SilentFailure): ActivityCoverage {
  return { source, state: "unavailable", failure };
}

function recordIncomplete(
  source: SourceIdentity,
  recorded: ActivityObservationSource,
  acts: number,
  unreadable: number,
): ActivityCoverage {
  const name = INTEGRATIONS[recorded].displayName;

  const sentences = [
    acts > 0
      ? `${acts} ${name} events reached Alfred, but the activity record does not hold them.`
      : null,
    unreadable > 0
      ? `${unreadable} activity rows of this window do not match this build of Alfred, so it cannot read them.`
      : null,
  ].filter((sentence) => sentence !== null);

  return {
    source,
    state: "unavailable",
    failure: {
      cause: "record_incomplete",
      reason: sentences.join(" "),
      acts,
      unreadable,
      recovery: { kind: "none" },
    },
  };
}

/** The one sentence about a delivery gap, without its full stop. */
function gapSentence(
  recorded: ActivityObservationSource,
  gap: DeliveryGap,
  reachesPresent: boolean,
): string {
  const name = INTEGRATIONS[recorded].displayName;

  if (reachesPresent) {
    return gap.from
      ? `No ${name} event has reached Alfred since ${gap.from.toISOString()}`
      : `No ${name} event has ever reached Alfred`;
  }

  return gap.from
    ? `No ${name} event reached Alfred from ${gap.from.toISOString()} to ${gap.to.toISOString()}`
    : `No ${name} event reached Alfred before ${gap.to.toISOString()}`;
}

/**
 * The verdict of each coverage entry after the evidence that the record does not hold (ADR-0118
 * decision 4). Each reader of the record calls this, so no reader keeps its own copy of the rule.
 *
 * - `unreadable`: the rows of the reader's window whose payload does not parse
 *   (`readActivityEvents`). The reader cannot tell the source of such a row, so each source with a
 *   reducer that is `live`, `record_incomplete`, or in a past gap becomes `record_incomplete`. A
 *   connection failure or a gap to now stays: neither is `live`, and its own recovery comes first.
 * - `evidence`: a provider read for each source with a reducer, which settles a silence.
 *   - A gap to now stays `silent` with its `connect` recovery, whatever the read proves. The read
 *     covers only some acts (the user's own merges for GitHub), so a dead source with other acts
 *     must not read as quiet.
 *   - The read checks each past gap. A past gap where the read holds a missed act stays `silent`.
 *     No reconnect repairs it.
 *   - A past gap where the read did not complete, or holds only a part, stays `silent`.
 *   - When the complete read holds no act in all the past gaps, the window has no events, for
 *     example a weekend. The source is `live`, and the operator log keeps the gaps.
 */
export function settleActivityCoverage(args: {
  userId: string;
  coverage: readonly ActivityCoverage[];
  unreadable: number;
  evidence: SilenceEvidence;
}): ActivityCoverage[] {
  const { userId, unreadable, evidence } = args;

  return args.coverage.map((entry) => {
    const { source } = entry;
    const recorded = activitySourceOf(source);

    if (recorded === null) return entry;

    if (entry.state === "live") {
      return unreadable > 0 ? recordIncomplete(source, recorded, 0, unreadable) : entry;
    }

    const { failure } = entry;

    switch (failure.cause) {
      case "record_incomplete":
        return unreadable > 0
          ? recordIncomplete(source, recorded, failure.acts, unreadable)
          : entry;
      case "silent":
        return settleSilence({ userId, source, recorded, failure, unreadable, evidence });
      // A connection failure is not `live`, and it has its own recovery.
      case "never_connected":
      case "broken":
      case "unknown":
      // A source with a reducer never has this cause.
      case "no_record":
        return entry;
      default:
        return assertNever(failure, "activity coverage failure");
    }
  });
}

function settleSilence(args: {
  userId: string;
  source: SourceIdentity;
  recorded: ActivityObservationSource;
  failure: SilentFailure;
  unreadable: number;
  evidence: SilenceEvidence;
}): ActivityCoverage {
  const { userId, source, recorded, failure, unreadable, evidence } = args;

  const proofOf = (gap: DeliveryGap): GapProof =>
    ACTIVITY_SOURCES[recorded].gapProof(evidence[recorded], gap);

  if (failure.reachesPresent) {
    return silentCoverage(source, {
      ...failure,
      reason: provedGapSentence(recorded, failure.gap, true, proofOf(failure.gap)),
    });
  }

  if (unreadable > 0) return recordIncomplete(source, recorded, 0, unreadable);

  const open = failure.gaps
    .map((gap) => ({ gap, proof: proofOf(gap) }))
    .filter(({ proof }) => proof.kind !== "none");

  const [first] = open;

  if (first === undefined) {
    logger.info(
      { userId, source: recorded, gaps: failure.gaps },
      "[activity.coverage] past delivery gaps settled as no events: the provider read found no act in them",
    );

    return { source, state: "live" };
  }

  // A missed act is the strongest finding, so its gap is the one that the reason names.
  const named = open.find(({ proof }) => proof.kind === "missed") ?? first;

  return silentCoverage(source, {
    ...failure,
    reason: withOtherGaps(
      provedGapSentence(recorded, named.gap, false, named.proof),
      open.length - 1,
    ),
  });
}

function provedGapSentence(
  recorded: ActivityObservationSource,
  delivery: DeliveryGap,
  reachesPresent: boolean,
  proof: GapProof,
): string {
  const name = INTEGRATIONS[recorded].displayName;
  const gap = gapSentence(recorded, delivery, reachesPresent);

  switch (proof.kind) {
    case "missed":
      return `${gap}, but ${proof.finding}.`;
    // Only a gap to now keeps this proof: the read covers only some acts.
    case "none":
      return `${gap}, and ${proof.finding}, but other ${name} events can be missing.`;
    case "unknown":
      return `${gap}, and Alfred could not confirm whether ${name} had anything to send.`;
    default:
      return assertNever(proof, "gap proof");
  }
}

/**
 * What the merged read (`is:pr is:merged author:@me`) proves about a GitHub gap. The read is a
 * provider call, so it sees a merge whose delivery never came. It covers the briefing's activity
 * window, so the part of a gap before the window start is not checked. The read returns one page,
 * so "no merge" is proof only when the page holds every merge of the read.
 */
function githubGapProof(read: GithubMergedReadOutcome, gap: DeliveryGap): GapProof {
  if (read.status !== "completed") return { kind: "unknown" };

  const { items, total } = read.read;

  // `mergedAt` is GitHub's time of the merge, and the gap bounds are arrival times. The delivery
  // that ends a gap can be the merge itself, and a delivery can still be in the queue, so only a
  // merge before `settledBy` is missed.
  const missedBefore = gap.settledBy.getTime();

  const missed = items.filter((item) => {
    const at = item.mergedAt.getTime();

    return (gap.from === null || at > gap.from.getTime()) && at < missedBefore;
  }).length;

  if (missed > 0) {
    return { kind: "missed", finding: `${missed} of the user's pull requests merged in that time` };
  }

  return items.length < total
    ? { kind: "unknown" }
    : { kind: "none", finding: "none of the user's pull requests merged in that time" };
}

/**
 * The acts of the user's GitHub deliveries in `[start, end)` that the record does not hold. The
 * same reducer as the writer names each act, so the check and the writer cannot disagree.
 */
async function countUnrecordedGithubActs(args: UnrecordedActsArgs): Promise<number> {
  const { userId, start, end, readFamilyHeads } = args;
  const docs = await readGithubActivityDocumentsBetween({ userId, start, end });
  const acts = docs.flatMap((doc) => githubActOf(doc) ?? []);

  const familyKeys = new Set(
    acts.flatMap((act) => (act.ownFamilyKey ? [act.familyKey, act.ownFamilyKey] : [act.familyKey])),
  );

  const heads = await readFamilyHeads(userId, [...familyKeys]);

  return acts.filter((act) => !isGithubActRecorded(act, (key) => heads.get(key))).length;
}

const gapRowSchema = z.object({
  from_at: z.coerce.date().nullable(),
  to_at: z.coerce.date(),
});

/**
 * Each silent gap in `[start, until)` between consecutive stored deliveries of `source`, in time
 * order. The last delivery before `start` opens the first gap, and `until` closes the last one.
 * `from` is `null` when no delivery came before the gap: the gap then starts at `start`. A gap is
 * silent when it is longer than `silenceBoundMs`, or when the source never delivered (`from` is
 * `null` and `to` is `until`). A GitHub document is one delivery, and `authored_at` is its arrival
 * time.
 */
async function silentDeliveryGaps(args: {
  userId: string;
  source: ActivityObservationSource;
  start: Date;
  until: Date;
  silenceBoundMs: number;
}): Promise<{ from: Date | null; to: Date }[]> {
  const { userId, source, start, until, silenceBoundMs } = args;

  const result = await db().execute(sql`
    with points as (
      select max(${documents.authoredAt}) as at
        from ${documents}
       where ${documents.userId} = ${userId}
         and ${documents.source} = ${source}
         and ${documents.authoredAt} < ${start}
      union all
      select ${documents.authoredAt}
        from ${documents}
       where ${documents.userId} = ${userId}
         and ${documents.source} = ${source}
         and ${documents.authoredAt} >= ${start}
         and ${documents.authoredAt} < ${until}
      union all
      select ${until}::timestamptz
    ),
    gaps as (
      select lag(at) over (order by at nulls first) as from_at, at as to_at
        from points
    )
    -- The first filter drops the row of the point before the window, and its null when there is none.
    select from_at, to_at
      from gaps
     where to_at >= ${start}
       and (
         to_at - coalesce(from_at, ${start}::timestamptz) > ${`${silenceBoundMs} milliseconds`}::interval
         or (from_at is null and to_at = ${until}::timestamptz)
       )
     order by to_at
  `);

  return rowsFromExecute(result, gapRowSchema).map((row) => ({ from: row.from_at, to: row.to_at }));
}
