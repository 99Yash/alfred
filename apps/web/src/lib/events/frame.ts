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
