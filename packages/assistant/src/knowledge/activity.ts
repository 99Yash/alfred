import { activityPayloadSchema, type ActivityVerb, type SourceIdentity } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, observationFamilyHeads, observations } from "@alfred/db/schemas";
import type { Document, Observation } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
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
 * The most rows that one read returns. A window with more rows gives the newest of them and
 * `truncated`. The briefing keeps 25 lines and calls a day of 8 acts busy, so the newest rows are
 * enough for it.
 */
const ACTIVITY_READ_MAX = 500;

interface ActivityEvents {
  /** Oldest first, by `occurredAt`, then `id`. A late event can sort before the window's start. */
  readonly events: readonly ActivityEvent[];
  /**
   * The rows whose payload does not parse. The insert schema parses every payload, so a count
   * above zero is drift between a writer and this build: the record of the window is not complete.
   */
  readonly unreadable: number;
  /** True when the window holds more than `ACTIVITY_READ_MAX` rows. `events` then holds the newest. */
  readonly truncated: boolean;
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
}): Promise<ActivityEvents> {
  const arrivedFrom = new Date(args.window.start.getTime() - ACTIVITY_DELIVERY_GRACE_MS);
  const arrivedBefore = new Date(args.window.end.getTime() - ACTIVITY_DELIVERY_GRACE_MS);

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
    .innerJoin(
      observations,
      and(
        eq(observations.userId, documents.userId),
        eq(observations.kind, "activity"),
        eq(documentIdOf(), documents.id),
      ),
    )
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(
      and(
        eq(documents.userId, args.userId),
        inArray(documents.source, [...ACTIVITY_SOURCE_SLUGS]),
        gte(documents.authoredAt, arrivedFrom),
        lt(documents.authoredAt, arrivedBefore),
      ),
    )
    // Newest first, so a cut keeps the newest rows. The result is reversed below.
    .orderBy(desc(observations.occurredAt), desc(observations.id))
    .limit(ACTIVITY_READ_MAX + 1);

  const truncated = rows.length > ACTIVITY_READ_MAX;
  let unreadable = 0;

  const events = rows
    .slice(0, ACTIVITY_READ_MAX)
    .reverse()
    .flatMap((row): ActivityEvent[] => {
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

  if (truncated) {
    logger.warn(
      { userId: args.userId, max: ACTIVITY_READ_MAX },
      "[activity] window holds more rows than one read returns",
    );
  }

  return { events, unreadable, truncated };
}

/**
 * The payload names the document that keeps the body (`activityPayloadSchema`). The expression is
 * the one that `observations_document_idx` keeps, so Postgres can probe the index with it.
 */
function documentIdOf(): SQL<string> {
  return sql<string>`(${observations.payload} ->> 'documentId')`;
}
