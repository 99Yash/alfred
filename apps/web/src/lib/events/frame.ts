import { getStringPath, isNonEmptyString, isRecord, safeJsonParse } from "@alfred/contracts";
import {
  eventFrameSchema,
  eventPayloadSchemas,
  type EventFrame,
  type EventKind,
  type EventPayload,
} from "@alfred/contracts/events";

/**
 * A single SSE message that survived validation, narrowed to its kind.
 *
 * The union is keyed on `kind`, so a consumer's `if (frame.kind === "chat.delta")`
 * gives it `EventPayload<"chat.delta">` with no cast, and reading a field that
 * belongs to a different kind is a compile error. Adding or changing a payload
 * schema in `@alfred/contracts/events` therefore fails the build at every
 * reader of that kind rather than at runtime.
 */
export type EventStreamFrame = {
  [K in EventKind]: Pick<EventFrame, "id" | "createdAt"> & {
    kind: K;
    payload: EventPayload<K>;
  };
}[EventKind];

/**
 * Validate one raw SSE message into a frame of `kind`, or `null` if anything
 * about it is off. The server validates on publish, but the wire format is JSON
 * and the browser treats it as untrusted: the payload goes through this kind's
 * own zod schema, and `data` / `lastEventId` arrive as `unknown` because the DOM
 * types hand them over as `any`.
 *
 * `id` comes from the SSE `id:` line (the outbox row's serial) and is checked
 * against the contract's own field schema, so a frame that reaches a consumer
 * always carries a positive integer cursor for `replay-anchor` to record.
 */
export function parseEventFrame<K extends EventKind>(
  kind: K,
  data: unknown,
  lastEventId: unknown,
): Extract<EventStreamFrame, { kind: K }> | null {
  if (!isNonEmptyString(data) || !isNonEmptyString(lastEventId)) return null;
  const parsed = safeJsonParse(data);
  if (!isRecord(parsed)) return null;
  const payload = eventPayloadSchemas[kind].safeParse(parsed.payload);
  if (!payload.success) return null;
  const id = eventFrameSchema.shape.id.safeParse(Number(lastEventId));
  if (!id.success) return null;
  // The one unchecked step in the module, and the reason this file has a test:
  // `payload` was produced by `eventPayloadSchemas[kind]` — the same `kind`
  // stamped on the frame two lines down — but TypeScript will not distribute a
  // generic indexed access, so `payload.data` widens to the union of *every*
  // kind's payload. Nothing may re-derive or shadow `kind` between the lookup
  // above and the literal below; `frame.test.ts` pins the pairing per kind.
  return {
    id: id.data,
    kind,
    payload: payload.data,
    createdAt: getStringPath(parsed, "createdAt") ?? "",
  } as Extract<EventStreamFrame, { kind: K }>;
}

/**
 * Every `EventKind` whose payload carries a `threadId` — derived from the
 * contract's own schemas, not listed. Five today: the four `chat.*` kinds and
 * `artifact.delta`.
 *
 * `"threadId" extends keyof …` rather than `EventPayload<K> extends { threadId:
 * string }` on purpose: `keyof` includes *optional* keys, so a future
 * `threadId?: string` payload is still classified, and it then types
 * `payload.threadId` as `string | undefined`, which fails `frameThreadId`'s
 * return type until the author writes `?? null`. The structural-extends form
 * would silently drop that payload back out of the set — the same "the gate
 * covers everything" claim, still false. (A `.passthrough()` payload schema puts
 * `string` in `keyof` and so is *over*-selected; that fails loudly at
 * `noThreadNamed`, which is the acceptable direction.)
 */
type ThreadScopedEventKind = {
  [K in EventKind]: "threadId" extends keyof EventPayload<K> ? K : never;
}[EventKind];

/**
 * The `default` arm of `frameThreadId`, and the reason it is a function rather
 * than a bare `return null`: its parameter type says *no thread-carrying kind
 * reaches here*, so adding a payload with a `threadId` without classifying it
 * below stops compiling at this call. Per
 * `.lessons/partial-union-exhaustiveness-guard-needs-a-parameter-not-a-dangling-alias.md`
 * the guard has to ride a parameter — `apps/web` sets `noUnusedLocals`, which
 * deletes a dangling `type _Assert` with TS6196.
 */
function noThreadNamed(_kind: Exclude<EventKind, ThreadScopedEventKind>): null {
  return null;
}

/**
 * The thread a frame names, or `null` for a kind that names none.
 *
 * The one reader of `payload.threadId` in `apps/web`: a payload that drops or
 * renames the field fails to compile here instead of at each subscriber that
 * spelled the comparison for itself. Both stream hooks scope their frames by
 * calling this *above* their kind dispatch, so an arm added later inherits the
 * check; `openEventStream` keeps one `EventSource` and broadcasts every frame to
 * every subscriber, so that scoping is load-bearing, not a formality.
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
