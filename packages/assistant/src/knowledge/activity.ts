import {
  activityPayloadSchema,
  isActivityVerb,
  type ActivityVerb,
  type IdentityRef,
  type SourceIdentity,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, observationFamilyHeads, observations } from "@alfred/db/schemas";
import type { Document, Observation } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, count, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  ACTIVITY_SOURCE_SLUGS,
  arrivalWindowOf,
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

/**
 * Who did the act. `user` is the user. Any other actor has the stable `identity` of the row's
 * subject, which keys the actor, and the provider's `login`, which names the actor. Two actors
 * with no login have different identities.
 */
type ActivityActor =
  | { readonly kind: "user" }
  | { readonly kind: "other"; readonly identity: IdentityRef; readonly login: string | null };

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

/** The most rows of one page. A window with more rows gives the newest of them and a `before` cursor. */
const ACTIVITY_READ_MAX = 500;

/**
 * The most pages that `readActivity` reads for one window, so one read gets at most
 * `ACTIVITY_READ_PAGE_CAP` times `ACTIVITY_READ_MAX` rows. A window with more rows makes each
 * source with a reducer `record_incomplete` (`capped`), so the briefing does not call the window
 * complete.
 */
const ACTIVITY_READ_PAGE_CAP = 20;

/** One page of the window. */
interface ActivityPage {
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

/**
 * The shape of a `before` cursor. A cursor is the id of an observation row, which
 * `createId("obs")` makes: the prefix, `_`, then 12 of `[0-9a-z]`.
 */
export const activityCursorSchema = z
  .string()
  .regex(/^obs_[0-9a-z]{12}$/, { error: "not an activity cursor" });

/** The count of acts in a window, by actor kind and verb. */
export interface ActivityCounts {
  readonly user: Partial<Record<ActivityVerb, number>>;
  readonly other: Partial<Record<ActivityVerb, number>>;
  /** The rows with no verb or a verb that this build does not declare. No bucket counts them. */
  readonly unreadable: number;
}

interface ActivityRead {
  /** The events of the whole window, oldest first, or of the newest pages when `capped`. */
  readonly events: readonly ActivityEvent[];
  /** The rows that the read got whose payload does not parse (`ActivityPage.unreadable`). */
  readonly unreadable: number;
  /** True when the window holds more rows than `ACTIVITY_READ_PAGE_CAP` pages. */
  readonly capped: boolean;
  /** The count of readable acts in the whole window, also when `capped`. */
  readonly acts: number;
  readonly coverage: readonly ActivityCoverage[];
}

/**
 * The events of `window` and the coverage of each source, read at `clock`. The read pages to the
 * end of the window, at most `ACTIVITY_READ_PAGE_CAP` pages, so `unreadable` covers each row that
 * it got.
 */
export async function readActivity(args: {
  userId: string;
  window: ActivityWindow;
  clock: Date;
}): Promise<ActivityRead> {
  const [read, coverage] = await Promise.all([
    readWindowPages(args),
    readActivityCoverage({ ...args, readFamilyHeads: readObservationFamilyHeads }),
  ]);

  const acts = read.capped ? await countActivityActs(args) : read.events.length;

  return { ...read, acts, coverage };
}

/** Each page of `window`, from the newest, until the oldest row or the page cap. */
async function readWindowPages(args: {
  userId: string;
  window: ActivityWindow;
}): Promise<Pick<ActivityRead, "events" | "unreadable" | "capped">> {
  const pages: (readonly ActivityEvent[])[] = [];
  let unreadable = 0;
  let before: string | undefined;

  // Each page needs the cursor of the page before it, so the pages are read one after the other.
  for (let read = 0; read < ACTIVITY_READ_PAGE_CAP; read += 1) {
    const page = await readActivityEvents({
      ...args,
      page: { before, limit: ACTIVITY_READ_MAX },
    });

    pages.push(page.events);
    unreadable += page.unreadable;

    if (page.before === null) {
      return { events: pages.toReversed().flat(), unreadable, capped: false };
    }

    before = page.before;
  }

  logger.warn(
    { userId: args.userId, pages: ACTIVITY_READ_PAGE_CAP, pageSize: ACTIVITY_READ_MAX },
    "[activity] window holds more rows than the page cap; the oldest rows are not read",
  );

  return { events: pages.toReversed().flat(), unreadable, capped: true };
}

/** The count of readable acts in `window`, of all actors and verbs (`countActivityEvents`). */
export async function countActivityActs(args: {
  userId: string;
  window: ActivityWindow;
}): Promise<number> {
  const counts = await countActivityEvents(args);

  return [counts.user, counts.other]
    .flatMap((bucket) => Object.values(bucket))
    .reduce((sum, acts) => sum + acts, 0);
}

/**
 * The events of `window` only, with no coverage. For a reader that already holds the coverage of
 * the same window, for example a composer tool that runs after the gather.
 *
 * The arrival of the delivery alone puts an act in a window: the act is in `window` when its
 * document's `authored_at` is in `arrivalWindowOf(window)`, which is `[start - G, end - G)`.
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
  /** One page of the window, newest first. Postgres applies the filter before the limit. */
  page: {
    /** Only the acts of this actor kind. Absent: the acts of all actors. */
    readonly actor?: ActivityActor["kind"] | undefined;
    /** Only the acts with this verb. Absent: all verbs. */
    readonly verb?: ActivityVerb | undefined;
    /** The `before` of the previous page. The page then holds only older acts. */
    readonly before?: string | undefined;
    /** The most rows of the page, at most `ACTIVITY_READ_MAX`. */
    readonly limit: number;
  };
}): Promise<ActivityPage> {
  const { page } = args;
  const limit = Math.min(page.limit, ACTIVITY_READ_MAX);

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
        page.actor === undefined
          ? undefined
          : page.actor === "user"
            ? eq(actorKindOf(), "user")
            : ne(actorKindOf(), "user"),
        page.verb === undefined ? undefined : eq(verbOf(), page.verb),
        page.before === undefined ? undefined : olderThan(args.userId, page.before),
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
            : { kind: "other", identity: row.actor, login: payload.data.actorLogin },
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

  return { events, unreadable, before };
}

/**
 * The count of acts in `window`, by actor kind and verb, for all rows of the window. Postgres
 * counts them, so the count is true when a read of the same window stops at its limit. The count
 * reads only the verb of each row. A row with no verb or an unknown verb counts as `unreadable`,
 * as `readActivityEvents` counts it. A row with a known verb and another payload fault counts in
 * its bucket here, but the read skips it.
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

  const user: ActivityCounts["user"] = {};
  const other: ActivityCounts["other"] = {};
  let unreadable = 0;

  for (const row of rows) {
    if (!isActivityVerb(row.verb)) {
      unreadable += row.acts;
      continue;
    }

    const bucket = row.actorKind === "user" ? user : other;

    bucket[row.verb] = (bucket[row.verb] ?? 0) + row.acts;
  }

  if (unreadable > 0) {
    logger.warn({ userId: args.userId, unreadable }, "[activity] unreadable activity rows counted");
  }

  return { user, other, unreadable };
}

/**
 * The activity rows of one document, for the same user. Returns `SQL`, never `undefined`, so a
 * silent cross join cannot compile (`liveObservationHeadJoin`).
 */
function activityRowOfDocument(): SQL {
  const predicate = and(
    eq(observations.userId, documents.userId),
    eq(observations.kind, "activity"),
    eq(documentIdOf(), documents.id),
  );

  if (!predicate) {
    // Unreachable: three defined predicates never fold to undefined.
    throw new Error("[activity] activityRowOfDocument produced an empty predicate");
  }

  return predicate;
}

/** The documents of the window, by arrival (`readActivityEvents`). */
function inActivityWindow(args: { userId: string; window: ActivityWindow }): SQL | undefined {
  const arrivals = arrivalWindowOf(args.window);

  return and(
    eq(documents.userId, args.userId),
    inArray(documents.source, [...ACTIVITY_SOURCE_SLUGS]),
    gte(documents.authoredAt, arrivals.start),
    lt(documents.authoredAt, arrivals.end),
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

/**
 * True when `before` names an activity row of the user. `olderThan` gives no rows for a cursor
 * that names no row, so a reader checks the cursor first. An unknown cursor is then not the end
 * of the list.
 */
export async function activityCursorExists(args: {
  userId: string;
  before: string;
}): Promise<boolean> {
  const rows = await db()
    .select({ id: observations.id })
    .from(observations)
    .where(
      and(
        eq(observations.id, args.before),
        eq(observations.userId, args.userId),
        eq(observations.kind, "activity"),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * `user` when the user did the act, else the kind of the actor's identity. Null when the identity
 * has no `kind`: such an actor is not the user.
 */
function actorKindOf(): SQL<string | null> {
  return sql<string | null>`(${observations.subjectIdentity} ->> 'kind')`;
}

/** The verb of the act (`activityPayloadSchema`). Null when the payload has no `verb`. */
function verbOf(): SQL<string | null> {
  return sql<string | null>`(${observations.payload} ->> 'verb')`;
}

/**
 * The payload names the document that keeps the body (`activityPayloadSchema`). The expression is
 * the one that `observations_document_idx` keeps, so Postgres can probe the index with it. Null when
 * the payload has no `documentId`: the join then matches no document.
 */
function documentIdOf(): SQL<string | null> {
  return sql<string | null>`(${observations.payload} ->> 'documentId')`;
}
