import { db, type DbTransaction } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { eventPayloadSchemas, type EventKind, type EventPayload } from "./types";

/**
 * Arguments for {@link publishEvent}. The outbox is the sole realtime fan-out
 * substrate (ADR-0005: "domain rows + an `events_outbox` row in one
 * transaction"), so the target the row is written on is not optional — the
 * author states one of two intents:
 *
 * - `tx`: a Drizzle transaction handle. The outbox row commits or rolls back
 *   with the domain write it describes. Pass this for every domain-write frame,
 *   so a rolled-back tx cannot leak a phantom event. The type is `DbTransaction`,
 *   not the pool-level `db()` root — passing the autocommitting root here no
 *   longer typechecks.
 * - `untransacted: true`: a deliberate non-domain publish (streaming progress, a
 *   post-commit release, a best-effort SSE poke, the dev demo). The row is
 *   written on the pool root and stands alone.
 *
 * Neither field is a default: omitting both is a no-overload type error, so the
 * old tier-5 "always pass `tx` for a domain write" rule is now the type.
 */
export type PublishEventArgs<K extends EventKind> = {
  userId: string;
  kind: K;
  payload: EventPayload<K>;
} & ({ tx: DbTransaction; untransacted?: never } | { untransacted: true; tx?: never });

/**
 * Insert one event into the outbox. Validates the payload against the kind's
 * zod schema BEFORE writing — a bad row is replayed to the client for as long
 * as it is retained (`OUTBOX_RETENTION_MS`, #533), and an unpublishable one is
 * never reaped at all. Throws on invalid payloads; callers should treat this as
 * a programming error, not a runtime fallback.
 */
export async function publishEvent<K extends EventKind>(args: PublishEventArgs<K>): Promise<void> {
  const schema = eventPayloadSchemas[args.kind];
  const parsed = schema.safeParse(args.payload);
  if (!parsed.success) {
    throw new Error(
      `[events:publish] payload for kind=${args.kind} failed validation: ${parsed.error.message}`,
    );
  }
  const executor = args.untransacted ? db() : args.tx;
  await executor.insert(eventsOutbox).values({
    userId: args.userId,
    kind: args.kind,
    payload: parsed.data,
  });
}
