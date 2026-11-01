import type { ActivityObservationSource, SourceIdentity } from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadCredentialRowsByProvider } from "../availability";
import type { EventDeliveryFailure, EventDeliveryRecovery } from "../ingress/descriptor";
import { readInboundTriggerHealth } from "../ingress/health";

/**
 * The coverage of each activity source for one window (ADR-0118 decision 4, in the ADR-0117
 * vocabulary). A reader that gets no events from an `unavailable` source must not say that
 * nothing happened.
 *
 * Two signals, and either one makes a source `unavailable`:
 * - Silence. A gap between two deliveries, or between the last delivery and the window's end, is
 *   longer than the source's bound. The gap can be anywhere in the window, so a day where the
 *   deliveries start again after an outage is still `unavailable`. This is the only signal for a
 *   past window: a credential row that a reconnect deleted leaves no record.
 * - Connection state, only for a window that reaches the present. The current credential says
 *   nothing about a past day.
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

export type ActivityCoverage =
  | { readonly source: SourceIdentity; readonly state: "live" }
  | {
      readonly source: SourceIdentity;
      readonly state: "unavailable";
      readonly failure: SilentFailure | Omit<EventDeliveryFailure, "healthy">;
    };

/** The coverage of every activity source for `window`, as of `now`. */
export async function readActivityCoverage(args: {
  userId: string;
  window: ActivityWindow;
  now: Date;
}): Promise<ActivityCoverage[]> {
  const { userId, window, now } = args;
  const source: SourceIdentity = { kind: "integration", slug: "github" };
  const reachesPresent = window.end.getTime() >= now.getTime();

  if (reachesPresent) {
    const health = (
      await readInboundTriggerHealth(userId, await loadCredentialRowsByProvider(userId))
    ).github;

    if (!health.healthy) {
      const { healthy: _healthy, ...failure } = health;

      return [{ source, state: "unavailable", failure }];
    }
  }

  // An open window is measured to now: the time after the last delivery is blind time too.
  const until = reachesPresent ? now : window.end;
  const gap = await longestDeliveryGap(userId, "github", window.start, until);

  const neverDelivered = gap.from === null && gap.to.getTime() === until.getTime();
  const gapMs = gap.to.getTime() - (gap.from ?? window.start).getTime();

  if (!neverDelivered && gapMs <= ACTIVITY_SOURCES.github.silenceBoundMs) {
    return [{ source, state: "live" }];
  }

  const recovery: EventDeliveryRecovery =
    reachesPresent && gap.to.getTime() === until.getTime()
      ? { kind: "connect", integration: "github" }
      : { kind: "none" };

  return [
    {
      source,
      state: "unavailable",
      failure: {
        cause: "silent",
        reason: gap.from
          ? `no GitHub delivery from ${gap.from.toISOString()} to ${gap.to.toISOString()}`
          : `no GitHub delivery before ${gap.to.toISOString()}`,
        gap,
        recovery,
      },
    },
  ];
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
