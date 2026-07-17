import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { eventPayloadSchemas, type EventKind, type EventPayload } from "./types";

/**
 * A Drizzle-compatible executor — either the pool-level `db()` handle or a
 * transaction handle yielded by `db().transaction(...)`. Both expose the same
 * `.insert(...)` surface, so a single helper can run inside or outside a tx.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventPublisher = any;

export interface PublishEventArgs<K extends EventKind> {
  /** Drizzle handle. Pass the surrounding tx so the outbox row commits with the domain write. */
  tx?: EventPublisher;
  userId: string;
  kind: K;
  payload: EventPayload<K>;
}

/**
 * Insert one event into the outbox. Validates the payload against the kind's
 * zod schema BEFORE writing — outbox rows are persisted forever, so garbage
 * in = garbage forever. Throws on invalid payloads; callers should treat this
 * as a programming error, not a runtime fallback.
 *
 * Always pass `tx` when an event corresponds to a domain write, so a rolled-
 * back tx doesn't leak phantom events.
 */
export async function publishEvent<K extends EventKind>(args: PublishEventArgs<K>): Promise<void> {
  const schema = eventPayloadSchemas[args.kind];
  const parsed = schema.safeParse(args.payload);
  if (!parsed.success) {
    throw new Error(
      `[events:publish] payload for kind=${args.kind} failed validation: ${parsed.error.message}`,
    );
  }
  const executor: EventPublisher = args.tx ?? db();
  await executor.insert(eventsOutbox).values({
    userId: args.userId,
    kind: args.kind,
    payload: parsed.data,
  });
}
