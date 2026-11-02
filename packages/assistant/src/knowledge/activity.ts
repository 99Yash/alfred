import {
  ACTIVITY_VERBS,
  activityPayloadSchema,
  type ActivityVerb,
  type SourceIdentity,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, observationFamilyHeads, observations } from "@alfred/db/schemas";
import type { Document, Observation } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, count, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ACTIVITY_DELIVERY_GRACE_MS,
  ACTIVITY_SOURCE_SLUGS,
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

/**
 * One act. `id` is the observation id. `occurredAt` is the provider's time of the act, not the
 * arrival time. `title` and `url` come from the document of the delivery.
 */
export type ActivityEvent = Pick<Observation, "id" | "occurredAt"> &
  Pick<Document, "title" | "url"> & {
    readonly source: SourceIdentity;
    readonly actor: ActivityActor;
    readonly verb: ActivityVerb;
    /** The `integration_objects` key of the thing. */
    readonly object: string | null;
  };

/**
 * The most rows that one read returns. A window with more rows gives the newest of them and a
 * `before` cursor. The briefing keeps 25 lines and calls a day of 8 acts busy, so the newest rows
 * are enough for the gather. A reader that must see older rows pages with `ActivityPageQuery`.
 */
const ACTIVITY_READ_MAX = 500;

/** One page of the window, newest first. Postgres applies the filter before the limit. */
interface ActivityPageQuery {
  /** Only the acts of this actor kind. Absent: the acts of all actors. */
  readonly actor?: ActivityActor["kind"] | undefined;
  /** Only the acts with this verb. Absent: all verbs. */
  readonly verb?: ActivityVerb | undefined;
  /** The `before` of the previous page. The page then holds only older acts. */
  readonly before?: string | undefined;
  /** The most rows of the page, at most `ACTIVITY_READ_MAX`. */
  readonly limit: number;
}

interface ActivityEvents {
  /** Oldest first, by `occurredAt`, then `id`. A late event can sort before the window's start. */
  readonly events: readonly ActivityEvent[];
  /**
   * The rows whose payload does not parse. The insert schema parses every payload, so a count
   * above zero is drift between a writer and this build: the record of the window is not complete.
   */
  readonly unreadable: number;
  /**
   * The cursor of the next older page, or null when this read holds the oldest row. It is the id
   * of the oldest row that the read got, also when that row does not parse. The next read compares
   * against the stored time of that row, so the cursor loses no microseconds of `occurred_at`.
   */
  readonly before: string | null;
}

/** The count of acts in a window, by actor kind and verb. */
export interface ActivityCounts {
  readonly user: Partial<Record<ActivityVerb, number>>;
  readonly other: Partial<Record<ActivityVerb, number>>;
}

export interface ActivityRead extends ActivityEvents {
  readonly coverage: readonly ActivityCoverage[];
}

/** The events of `window` and the coverage of each source, read at `clock`. */
export async function readActivity(args: {
  userId: string;
  window: ActivityWindow;
  clock: Date;
}): Promise<ActivityRead> {
  const [events, coverage] = await Promise.all([
    readActivityEvents(args),
    readActivityCoverage({ ...args, readFamilyHeads: readObservationFamilyHeads }),
  ]);

  return { ...events, coverage };
}

/**
 * The events of `window` only, with no coverage. For a reader that already holds the coverage of
 * the same window, for example a composer tool that runs after the gather.
 *
 * The arrival of the delivery alone puts an act in a window: the act is in `window` when its
 * document's `authored_at` is in `[start - G, end - G)`, where G is `ACTIVITY_DELIVERY_GRACE_MS`.
 * Consecutive windows share their bounds, so each act reaches one reader only:
 * - The time of the act does not count. An act always comes before its delivery, so an act near
 *   the end of one window that arrives in the next window is in the next window only.
 * - The shift by G gives the queued writer time to write the row after the document commits. A
 *   delivery that arrives just before the end is in the next window, and its row exists then.
 * - A late delivery (a queue retry, a provider that sends late) is in the window of its arrival.
 * - A replay does not flood a window with old acts: its row names the document of the first
 *   delivery, which arrived long before the replay.
 *
 * A row reaches no window when its document is gone, because the arrival is then not known. The
 * payload schema requires `documentId`, and only the user cascade deletes a GitHub document.
 */
export async function readActivityEvents(args: {
  userId: string;
  window: ActivityWindow;
  /** Absent: the newest `ACTIVITY_READ_MAX` rows of the window, with no filter. */
  page?: ActivityPageQuery;
}): Promise<ActivityEvents> {
  const page = args.page;
  const limit = Math.min(page?.limit ?? ACTIVITY_READ_MAX, ACTIVITY_READ_MAX);

  // The documents of the window come from `documents_user_source_idx`, and each one finds its rows
  // through `observations_document_idx`. So the cost follows the window, not the user's history.
  const rows = await db()
    .select({
      id: observations.id,
      occurredAt: observations.occurredAt,
      actor: observations.subjectIdentity,
      object: observations.objectIdentity,
      payload: observations.payload,
      title: documents.title,
      url: documents.url,
    })
    .from(documents)
    .innerJoin(observations, activityRowOfDocument())
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(
      and(
        inActivityWindow(args),
        page?.actor === undefined
          ? undefined
          : page.actor === "user"
            ? eq(actorKindOf(), "user")
            : ne(actorKindOf(), "user"),
        page?.verb === undefined ? undefined : eq(verbOf(), page.verb),
        page?.before === undefined ? undefined : olderThan(args.userId, page.before),
      ),
    )
    // Newest first, so a cut keeps the newest rows. The result is reversed below.
    .orderBy(desc(observations.occurredAt), desc(observations.id))
    .limit(limit + 1);

  const kept = rows.slice(0, limit);
  const before = rows.length > limit ? (kept.at(-1)?.id ?? null) : null;
  let unreadable = 0;

  const events = kept.toReversed().flatMap((row): ActivityEvent[] => {
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
          row.actor.kind === "user"
            ? { kind: "user" }
            : { kind: "other", login: payload.data.actorLogin },
        verb: payload.data.verb,
        object: row.object?.value ?? null,
        title: row.title,
        url: row.url,
      },
    ];
  });

  if (unreadable > 0) {
    logger.warn({ userId: args.userId, unreadable }, "[activity] unreadable activity rows skipped");
  }

  if (before !== null && page === undefined) {
    logger.warn(
      { userId: args.userId, max: ACTIVITY_READ_MAX },
      "[activity] window holds more rows than one read returns",
    );
  }

  return { events, unreadable, before };
}

/**
 * The count of acts in `window`, by actor kind and verb, for all rows of the window. Postgres
 * counts them, so the count is true when a read of the same window stops at its limit. The count
 * reads only the verb of each row. A row with an unknown verb is not counted.
 */
export async function countActivityEvents(args: {
  userId: string;
  window: ActivityWindow;
}): Promise<ActivityCounts> {
  const actorKind = actorKindOf();
  const verb = verbOf();

  const rows = await db()
    .select({ actorKind, verb, acts: count() })
    .from(documents)
    .innerJoin(observations, activityRowOfDocument())
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(inActivityWindow(args))
    .groupBy(actorKind, verb);

  const counts: ActivityCounts = { user: {}, other: {} };

  for (const row of rows) {
    const known = ACTIVITY_VERBS.find((candidate) => candidate === row.verb);

    if (known === undefined) continue;
    const bucket = counts[row.actorKind === "user" ? "user" : "other"];

    bucket[known] = (bucket[known] ?? 0) + row.acts;
  }

  return counts;
}

/** The activity rows of one document. */
function activityRowOfDocument(): SQL | undefined {
  return and(
    eq(observations.userId, documents.userId),
    eq(observations.kind, "activity"),
    eq(documentIdOf(), documents.id),
  );
}

/** The documents of the window, by arrival (`readActivityEvents`). */
function inActivityWindow(args: { userId: string; window: ActivityWindow }): SQL | undefined {
  const arrivedFrom = new Date(args.window.start.getTime() - ACTIVITY_DELIVERY_GRACE_MS);
  const arrivedBefore = new Date(args.window.end.getTime() - ACTIVITY_DELIVERY_GRACE_MS);

  return and(
    eq(documents.userId, args.userId),
    inArray(documents.source, [...ACTIVITY_SOURCE_SLUGS]),
    gte(documents.authoredAt, arrivedFrom),
    lt(documents.authoredAt, arrivedBefore),
  );
}

/**
 * The rows that sort after the cursor row in the read order. Postgres reads the time of the cursor
 * row, so the compare is exact. A cursor that names no row of the user gives no rows.
 */
function olderThan(userId: string, before: string): SQL {
  const cursor = alias(observations, "activity_cursor");

  const cursorRow = db()
    .select({ occurredAt: cursor.occurredAt, id: cursor.id })
    .from(cursor)
    .where(and(eq(cursor.id, before), eq(cursor.userId, userId)));

  return sql`(${observations.occurredAt}, ${observations.id}) < ${cursorRow}`;
}

/** `user` when the user did the act, else the kind of the actor's identity. */
function actorKindOf(): SQL<string> {
  return sql<string>`(${observations.subjectIdentity} ->> 'kind')`;
}

/** The verb of the act (`activityPayloadSchema`). */
function verbOf(): SQL<string> {
  return sql<string>`(${observations.payload} ->> 'verb')`;
}

/**
 * The payload names the document that keeps the body (`activityPayloadSchema`). The expression is
 * the one that `observations_document_idx` keeps, so Postgres can probe the index with it.
 */
function documentIdOf(): SQL<string> {
  return sql<string>`(${observations.payload} ->> 'documentId')`;
}
