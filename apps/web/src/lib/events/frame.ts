import { getStringPath, isNonEmptyString, isRecord, safeJsonParse } from "@alfred/contracts";
import {
  eventFrameSchema,
  eventPayloadSchemas,
  type EventFrame,
  type EventKind,
  type EventPayload,
} from "@alfred/contracts/events";

/**
 * A validated SSE message, narrowed by `kind` so each payload is typed without a cast.
 * `Omit` keeps any new envelope field from `EventFrame` without a second edit.
 */
export type EventStreamFrame = {
  [K in EventKind]: Omit<EventFrame, "kind" | "payload"> & {
    kind: K;
    payload: EventPayload<K>;
  };
}[EventKind];

/**
 * Validate one untrusted SSE message into a frame of `kind`, or `null`.
 * Takes the `MessageEvent` as one object: two swapped `unknown` positionals once killed the stream silently.
 * `id` is the outbox serial from the SSE `id:` line.
 */
export function parseEventFrame<K extends EventKind>(
  kind: K,
  msg: { data: unknown; lastEventId: unknown },
): Extract<EventStreamFrame, { kind: K }> | null {
  if (!isNonEmptyString(msg.data) || !isNonEmptyString(msg.lastEventId)) return null;
  const parsed = safeJsonParse(msg.data);

  if (!isRecord(parsed)) return null;
  const payload = eventPayloadSchemas[kind].safeParse(parsed.payload);

  if (!payload.success) return null;
  const id = eventFrameSchema.shape.id.safeParse(Number(msg.lastEventId));

  if (!id.success) return null;

  // `satisfies EventFrame` catches a missing required envelope field; a bare `as` would not.
  // SAFETY: `eventPayloadSchemas[kind]` parsed the payload, but TypeScript widens a generic
  // indexed access to every kind's payload. Do not re-derive `kind` between the two.
  return {
    id: id.data,
    kind,
    payload: payload.data,
    createdAt: getStringPath(parsed, "createdAt") ?? "",
  } satisfies EventFrame as Extract<EventStreamFrame, { kind: K }>;
}

/**
 * Every `EventKind` whose payload has a `threadId`, derived from the schemas.
 * `keyof` also catches an optional `threadId`. Gap: a union payload with
 * `threadId` on only some variants is missed.
 */
type ThreadScopedEventKind = {
  [K in EventKind]: "threadId" extends keyof EventPayload<K> ? K : never;
}[EventKind];

/**
 * A function, not `return null`: a thread-carrying kind that reaches here fails to compile.
 * The guard rides a parameter because `noUnusedLocals` rejects a dangling type alias.
 */
function noThreadNamed(_kind: Exclude<EventKind, ThreadScopedEventKind>): null {
  return null;
}

/**
 * The thread a frame names, or `null`. One `EventSource` sends every frame to
 * every subscriber, so stream hooks call this before their kind dispatch.
 */
export function frameThreadId(frame: EventStreamFrame): string | null {
  switch (frame.kind) {
    case "chat.message":
    case "chat.reasoning":
    case "chat.delta":
    case "chat.tool":
    case "artifact.delta":
      return frame.payload.threadId;
    default:
      return noThreadNamed(frame.kind);
  }
}
