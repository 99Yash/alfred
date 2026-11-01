import type { ActivityObservationSource, SourceIdentity } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq, lt, max } from "drizzle-orm";
import { loadCredentialRowsByProvider } from "../availability";
import type { EventDeliveryFailure } from "../ingress/descriptor";
import { readInboundTriggerHealth } from "../ingress/health";

/**
 * The coverage of each activity source for one window (ADR-0118 decision 4, in the ADR-0117
 * vocabulary). A reader that gets no events from an `unavailable` source must not say that
 * nothing happened.
 *
 * Two signals, and either one makes a source `unavailable`:
 * - Silence. The last delivery before the window ends is older than the source's bound. This is the
 *   only signal for a past window: a credential row that a reconnect deleted leaves no record.
 * - Connection state, only for a window that reaches the present. The current credential says
 *   nothing about a past day.
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

/** No delivery inside the source's bound. The cause names the last delivery, or that none exists. */
interface SilentFailure {
  readonly cause: "silent";
  readonly reason: string;
  readonly recovery: { readonly kind: "connect"; readonly integration: ActivityObservationSource };
}

export type ActivityCoverage =
  | { readonly source: SourceIdentity; readonly state: "live"; readonly lastEventAt: Date }
  | {
      readonly source: SourceIdentity;
      readonly state: "unavailable";
      /** The last delivery before the window ends. `null`: the source never delivered. */
      readonly lastEventAt: Date | null;
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
  const lastEventAt = await lastDeliveryBefore(userId, "github", window.end);
  const { silenceBoundMs } = ACTIVITY_SOURCES.github;

  // A window that reaches the present also reads the connection.
  if (window.end.getTime() >= now.getTime() - silenceBoundMs) {
    const health = (
      await readInboundTriggerHealth(userId, await loadCredentialRowsByProvider(userId))
    ).github;

    if (!health.healthy) {
      const { healthy: _healthy, ...failure } = health;

      return [{ source, state: "unavailable", lastEventAt, failure }];
    }
  }

  // Measured to the window's end, or to now for an open window: a gap after the last
  // delivery is blind time even when the window itself held events.
  const until = Math.min(window.end.getTime(), now.getTime());

  if (!lastEventAt || until - lastEventAt.getTime() > silenceBoundMs) {
    return [
      {
        source,
        state: "unavailable",
        lastEventAt,
        failure: {
          cause: "silent",
          reason: lastEventAt
            ? `no GitHub delivery since ${lastEventAt.toISOString()}`
            : "GitHub never delivered an event",
          recovery: { kind: "connect", integration: "github" },
        },
      },
    ];
  }

  return [{ source, state: "live", lastEventAt }];
}

/** The newest stored delivery of `source` before `end`. A GitHub document is one delivery. */
async function lastDeliveryBefore(
  userId: string,
  source: ActivityObservationSource,
  end: Date,
): Promise<Date | null> {
  const [row] = await db()
    .select({ at: max(documents.authoredAt) })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, source),
        lt(documents.authoredAt, end),
      ),
    );

  return row?.at ?? null;
}
