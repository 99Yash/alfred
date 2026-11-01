import {
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
import { documents, typedEventReceipts } from "@alfred/db/schemas";
import { and, count, eq, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { readIntegrationAvailability } from "../availability";
import type { EventDeliveryFailure, EventDeliveryRecovery } from "../ingress/descriptor";
import { readInboundTriggerHealth } from "../ingress/health";
import { builtInProviderForEndpoint } from "../mcp/built-ins";
import { listOwnedConnections } from "../mcp/persistence";

/**
 * The coverage of each connected source for one window (ADR-0118 decision 4, in the ADR-0117
 * vocabulary). A reader that gets no events from an `unavailable` source must not say that
 * nothing happened. Every connected source gets one entry: a credential provider, a built-in MCP
 * server (named by its registry slug), and a server that the user added.
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
 * - An incomplete record. A delivery arrived, but its receipt is not `completed`: the activity
 *   writer failed all its attempts, or the queue did not run it. The document exists, so the
 *   silence check cannot see this. A redelivery of the receipt runs the writer again, and the
 *   receipt then becomes `completed`.
 *
 * Only a gap that reaches the present tells the user to connect. A past gap cannot be repaired
 * now, so its recovery is `none`: the reader still must not call the window quiet.
 */

/** How long each activity source can be silent before Alfred stops trusting a quiet window. */
const ACTIVITY_SOURCES = {
  /**
   * 24 hours. From 2026-10-10 to 2026-11-01 the longest gap between two GitHub deliveries was
   * 14 h 41 min, except the 6-day outage from 2026-10-22. A day with no work at all can still read
   * as `unavailable`; that is the cost of not reading a dead source as a quiet one.
   */
  github: { silenceBoundMs: 24 * 60 * 60 * 1000 },
} as const satisfies { readonly [S in ActivityObservationSource]: { silenceBoundMs: number } };

const ACTIVITY_SOURCE_SLUGS = typedKeys(ACTIVITY_SOURCES);

function activitySourceOf(source: SourceIdentity): ActivityObservationSource | null {
  if (source.kind !== "integration") return null;

  return ACTIVITY_SOURCE_SLUGS.find((slug) => slug === source.slug) ?? null;
}

/**
 * A receipt younger than this can still be in the queue: `ingress.deliver` makes five attempts
 * with an exponential 5 s backoff, about 75 s in total.
 */
const DELIVERY_GRACE_MS = 15 * 60 * 1000;

/** The window that the reader asks about: `start` inclusive, `end` exclusive. */
export interface ActivityWindow {
  readonly start: Date;
  readonly end: Date;
}

/** A delivery gap longer than the source's bound. `from` is `null` when no delivery came before. */
interface SilentFailure {
  readonly cause: "silent";
  readonly reason: string;
  readonly gap: { readonly from: Date | null; readonly to: Date };
  readonly recovery: EventDeliveryRecovery;
}

/** Deliveries arrived, but the activity writer did not finish them. */
interface RecordIncompleteFailure {
  readonly cause: "record_incomplete";
  readonly reason: string;
  /** The receipts in the window that are not `completed`. */
  readonly receipts: number;
  readonly recovery: { readonly kind: "retry" };
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

/** The coverage of every connected source for `window`, as of `now`. */
export async function readActivityCoverage(args: {
  userId: string;
  window: ActivityWindow;
  now: Date;
}): Promise<ActivityCoverage[]> {
  const { userId } = args;

  const [availability, connections] = await Promise.all([
    readIntegrationAvailability(userId),
    listOwnedConnections(userId),
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

  return Promise.all(
    [...sources.values()].map(async (source) => {
      const recorded = activitySourceOf(source);

      return recorded
        ? recordedSourceCoverage({ ...args, source, recorded, rows: availability.providers })
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

async function recordedSourceCoverage(args: {
  userId: string;
  window: ActivityWindow;
  now: Date;
  source: SourceIdentity;
  recorded: ActivityObservationSource;
  rows: CredentialRowsByProvider;
}): Promise<ActivityCoverage> {
  const { userId, window, now, source, recorded, rows } = args;
  const reachesPresent = window.end.getTime() >= now.getTime();

  if (reachesPresent) {
    const health = (await readInboundTriggerHealth(userId, rows))[recorded];

    if (!health.healthy) {
      const { healthy: _healthy, ...failure } = health;

      return { source, state: "unavailable", failure };
    }
  }

  // An open window is measured to now: the time after the last delivery is blind time too.
  const until = reachesPresent ? now : window.end;

  const [gap, unfinished] = await Promise.all([
    longestDeliveryGap(userId, recorded, window.start, until),
    countUnfinishedReceipts(userId, recorded, window.start, until, now),
  ]);

  const neverDelivered = gap.from === null && gap.to.getTime() === until.getTime();
  const gapMs = gap.to.getTime() - (gap.from ?? window.start).getTime();

  if (neverDelivered || gapMs > ACTIVITY_SOURCES[recorded].silenceBoundMs) {
    const recovery: EventDeliveryRecovery =
      reachesPresent && gap.to.getTime() === until.getTime()
        ? { kind: "connect", integration: recorded }
        : { kind: "none" };

    return {
      source,
      state: "unavailable",
      failure: {
        cause: "silent",
        reason: gap.from
          ? `no ${recorded} delivery from ${gap.from.toISOString()} to ${gap.to.toISOString()}`
          : `no ${recorded} delivery before ${gap.to.toISOString()}`,
        gap,
        recovery,
      },
    };
  }

  if (unfinished > 0) {
    return {
      source,
      state: "unavailable",
      failure: {
        cause: "record_incomplete",
        reason: `${unfinished} ${recorded} deliveries in the window are not in the activity record`,
        receipts: unfinished,
        recovery: { kind: "retry" },
      },
    };
  }

  return { source, state: "live" };
}

/**
 * The receipts of `source` delivered in `[start, until)` that are not `completed`, without the
 * ones younger than {@link DELIVERY_GRACE_MS}. `completed` means that every `propagate` consumer
 * finished, and the activity writer is one of them. A failure of another consumer also counts:
 * the reader cannot tell which consumer failed, so it does not trust the window.
 */
async function countUnfinishedReceipts(
  userId: string,
  source: ActivityObservationSource,
  start: Date,
  until: Date,
  now: Date,
): Promise<number> {
  const settled = new Date(Math.min(until.getTime(), now.getTime() - DELIVERY_GRACE_MS));

  if (settled.getTime() <= start.getTime()) return 0;

  const [row] = await db()
    .select({ unfinished: count() })
    .from(typedEventReceipts)
    .where(
      and(
        eq(typedEventReceipts.userId, userId),
        eq(typedEventReceipts.provider, source),
        gte(typedEventReceipts.deliveredAt, start),
        lt(typedEventReceipts.deliveredAt, settled),
        ne(typedEventReceipts.processingStatus, "completed"),
      ),
    );

  return row?.unfinished ?? 0;
}

const gapRowSchema = z.object({
  from_at: z.coerce.date().nullable(),
  to_at: z.coerce.date(),
});

/**
 * The longest gap in `[start, until)` between consecutive stored deliveries of `source`. The last
 * delivery before `start` opens the first gap, and `until` closes the last one. `from` is `null`
 * when no delivery came before the gap: the gap then starts at `start`, or the source never
 * delivered when `to` is `until`. A GitHub document is one delivery, and `authored_at` is its
 * arrival time.
 */
async function longestDeliveryGap(
  userId: string,
  source: ActivityObservationSource,
  start: Date,
  until: Date,
): Promise<{ from: Date | null; to: Date }> {
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
    -- The filter drops the row of the point before the window, and its null when there is none.
    select from_at, to_at
      from gaps
     where to_at >= ${start}
     order by to_at - coalesce(from_at, ${start}::timestamptz) desc
     limit 1
  `);

  const [row] = rowsFromExecute(result, gapRowSchema);

  // The `until` point always gives one row; the fallback only satisfies the type.
  return row ? { from: row.from_at, to: row.to_at } : { from: null, to: until };
}
