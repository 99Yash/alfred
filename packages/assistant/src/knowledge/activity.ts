import {
  activityPayloadSchema,
  INTEGRATION_ACTIVITY_TITLE_MAX,
  type ActivityVerb,
  type IntegrationActivityItem,
  type SourceIdentity,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, observationFamilyHeads, observations } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, asc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  readActivityCoverage,
  type ActivityCoverage,
  type ActivityWindow,
} from "@alfred/assistant/connections";
import { liveObservationHeadJoin, readObservationFamilyHeads } from "./observations";

/**
 * The one local reader of the activity record (ADR-0118 decision 6). It reads the live head of
 * each activity family in the window, in time order, and the coverage of each source for the same
 * window. It uses no embedding, no model, and no provider call. A reader that gets no events from
 * a source whose coverage is `unavailable` must not say that nothing happened.
 *
 * The row does not copy the delivery body, so the reader joins the `documents` row that keeps it
 * for the title and the link.
 */

/** Who did the act. `user` is the user; any other actor is named by the provider's login. */
type ActivityActor =
  | { readonly kind: "user" }
  | { readonly kind: "other"; readonly login: string | null };

/** The actor as a briefing names it: `you` for the user, else the provider login. */
export function activityActorLabel(actor: ActivityActor): string {
  return actor.kind === "user" ? "you" : (actor.login ?? "someone");
}

export interface ActivityEvent {
  /** The observation id. */
  readonly id: string;
  /** The provider's time of the act, not the arrival time. */
  readonly occurredAt: Date;
  readonly source: SourceIdentity;
  readonly actor: ActivityActor;
  readonly verb: ActivityVerb;
  /** The `integration_objects` key of the thing. */
  readonly object: string | null;
  readonly title: string | null;
  readonly url: string | null;
}

export interface ActivityRead {
  /** Oldest first, by `occurredAt`. A late event sorts before the window's start. */
  readonly events: readonly ActivityEvent[];
  readonly coverage: readonly ActivityCoverage[];
}

/** The events of `window` and the coverage of each source, as of `now`. */
export async function readActivity(args: {
  userId: string;
  window: ActivityWindow;
  now: Date;
}): Promise<ActivityRead> {
  const [events, coverage] = await Promise.all([
    readActivityEvents(args),
    readActivityCoverage({ ...args, readFamilyHeads: readObservationFamilyHeads }),
  ]);

  return { events, coverage };
}

/**
 * The events of `window` only, with no coverage. For a reader that already holds the coverage of
 * the same window, for example a composer tool that runs after the gather.
 *
 * An event is in the window when it happened in the window, or when it happened before the window
 * and its delivery arrived in the window. A late delivery (a queue retry, a provider that sends
 * late) then reaches the next reader, not none. The arrival is the document's `authored_at`, the
 * clock that coverage reads. A replay does not use this arm: its row joins the document of the
 * first delivery, which arrived long before the replay. So a replay cannot flood one window with
 * old acts.
 */
export async function readActivityEvents(args: {
  userId: string;
  window: ActivityWindow;
}): Promise<ActivityEvent[]> {
  const rows = await db()
    .select({
      id: observations.id,
      occurredAt: observations.occurredAt,
      subject: observations.subjectIdentity,
      object: observations.objectIdentity,
      payload: observations.payload,
      title: documents.title,
      url: documents.url,
    })
    .from(observations)
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .leftJoin(
      documents,
      and(eq(documents.userId, observations.userId), eq(documents.id, documentIdOf())),
    )
    .where(
      and(
        eq(observations.userId, args.userId),
        eq(observations.kind, "activity"),
        or(
          and(
            gte(observations.occurredAt, args.window.start),
            lt(observations.occurredAt, args.window.end),
          ),
          and(
            lt(observations.occurredAt, args.window.start),
            // `= any(array(...))` probes `documents_user_source_idx` with the window. A filter on
            // the joined `documents` row makes Postgres hash every document of the user.
            sql`${documentIdOf()} = any(array(${arrivedDocumentIds(args)}))`,
          ),
        ),
      ),
    )
    .orderBy(asc(observations.occurredAt), asc(observations.id));

  let unreadable = 0;

  const events = rows.flatMap((row): ActivityEvent[] => {
    const payload = activityPayloadSchema.safeParse(row.payload);

    if (!payload.success) {
      unreadable += 1;

      return [];
    }

    return [
      {
        id: row.id,
        occurredAt: row.occurredAt,
        source: payload.data.source,
        actor:
          row.subject.kind === "user"
            ? { kind: "user" }
            : { kind: "other", login: payload.data.actorLogin },
        verb: payload.data.verb,
        object: row.object?.value ?? null,
        title: row.title,
        url: row.url,
      },
    ];
  });

  // The insert schema parses every payload, so a miss here is drift between a writer and this build.
  if (unreadable > 0) {
    logger.warn({ userId: args.userId, unreadable }, "[activity] unreadable activity rows skipped");
  }

  return events;
}

/** The payload names the document that keeps the body (`activityPayloadSchema`). */
function documentIdOf(): SQL<string> {
  return sql<string>`${observations.payload}->>'documentId'`;
}

/** The ids of the row's source documents that arrived in `window`. Correlated on the row's source. */
function arrivedDocumentIds(args: { userId: string; window: ActivityWindow }) {
  const arrived = alias(documents, "arrived");

  return db()
    .select({ id: arrived.id })
    .from(arrived)
    .where(
      and(
        eq(arrived.userId, args.userId),
        eq(arrived.source, observations.source),
        gte(arrived.authoredAt, args.window.start),
        lt(arrived.authoredAt, args.window.end),
      ),
    );
}

/**
 * The briefing activity line of one event, or of one run of pushes. A run of pushes by one actor
 * to one object is one line with a `rollup` count, so a day of pushes does not fill the list.
 */
export function activityItemsOf(
  events: readonly ActivityEvent[],
  max: number,
): IntegrationActivityItem[] {
  const newest = [...events].reverse();
  const pushRuns = new Map<string, { item: IntegrationActivityItem; count: number }>();
  const items: IntegrationActivityItem[] = [];

  for (const event of newest) {
    if (event.source.kind !== "integration") continue;
    const actor = activityActorLabel(event.actor);

    if (event.verb === "pushed" && event.object) {
      const key = `${actor}\u001f${event.object}`;
      const run = pushRuns.get(key);

      if (run) {
        run.count += 1;
        run.item.rollup = { eventCount: run.count };
        continue;
      }
    }

    if (items.length >= max) continue;
    const subject = event.title ?? event.object ?? event.source.slug;

    const item: IntegrationActivityItem = {
      id: event.id,
      provider: event.source.slug,
      source: "direct_api",
      activityCategory: "work",
      providerKind: `${event.source.slug}.${event.verb}`,
      title: `${actor} ${event.verb}: ${subject}`.slice(0, INTEGRATION_ACTIVITY_TITLE_MAX),
      severity: "info",
      occurredAt: event.occurredAt.toISOString(),
      ...(event.url ? { url: event.url } : {}),
    };

    items.push(item);

    if (event.verb === "pushed" && event.object) {
      pushRuns.set(`${actor}\u001f${event.object}`, { item, count: 1 });
    }
  }

  return items;
}
