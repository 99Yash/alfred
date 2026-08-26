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
 *
 * The envelope is **derived, not listed**: `Omit` subtracts the two fields this
 * union replaces and keeps whatever else `EventFrame` declares, so a *required*
 * field added to `eventFrameSchema` appears here on its own, where the
 * equivalent-today `Pick<EventFrame, "id" | "createdAt">` would need a second
 * edit to name it. That is all `Omit` buys, and it is worth being exact about
 * which word does what, because three plausible readings are wrong (each probed
 * on this tree):
 *
 * - `Omit` buys **provenance**, not enforcement. The two spellings are the same
 *   type while `EventFrame` has four fields.
 * - The **enforcer of field presence is `satisfies EventFrame`** on
 *   `parseEventFrame`'s return literal, and it enforces under *either* spelling:
 *   a literal missing `createdAt` is TS2741 with `Pick` and with `Omit` alike,
 *   while a bare `as` accepts it under *both*. The bare cast was the hole; the
 *   spelling of this type never closed it.
 * - Narrowing this type is not a free rewrite. Spell it
 *   `Pick<EventFrame, "id">` and three separate things fail: the cast in
 *   `parseEventFrame` (TS2352 — `as` needs the two types to overlap), the
 *   `createdAt` read in the debug events page (TS2339), and the envelope
 *   assignment in `frame.test.ts` (TS2741). The same pair — that cast and that
 *   assignment — fires on the case this type exists for: a contract that grows
 *   a required field the literal then carries and a `Pick` form would drop.
 *   Neither home is free, and one of them is a test, so keep it a *type* check:
 *   `apps/web` tests are typechecked by `tsc -p tsconfig.test.json` in web's
 *   `check-types`, and are not run in CI yet.
 */
export type EventStreamFrame = {
  [K in EventKind]: Omit<EventFrame, "kind" | "payload"> & {
    kind: K;
    payload: EventPayload<K>;
  };
}[EventKind];

/**
 * Validate one raw SSE message into a frame of `kind`, or `null` if anything
 * about it is off. The server validates on publish, but the wire format is JSON
 * and the browser treats it as untrusted: the payload goes through this kind's
 * own zod schema, and both message fields are declared `unknown` here because
 * this function is the boundary that validates them — not because the DOM says
 * so. The DOM types are uneven: `MessageEvent.data` is `any` and
 * `MessageEvent.lastEventId` is `string` (probed).
 *
 * The message is taken as **one object, not two positionals**. Both wire inputs
 * are `unknown` and mutually substitutable, so a transposed *pair* returned
 * `null` for every message — a silently dead stream with no error, no failing
 * test and no console line. `MessageEvent` satisfies this parameter
 * structurally, so a caller forwards the event it already holds and wires no
 * fields at all; the three-positional form no longer compiles (TS2554).
 * Forwarding the whole event is safe to do twice because `data` and
 * `lastEventId` are `readonly` IDL attributes, not because this function reads
 * each one once.
 *
 * What this does not buy, stated so nobody reads more into it: a caller that
 * hand-builds the object with the two fields *crossed* still compiles, because
 * both are `unknown` deliberately. Narrowing `lastEventId` to `string` would not
 * catch it either — `data` is `any`, and `any` is assignable to `string`. The
 * positional accident is gone; a deliberate mislabel is not type-level. Probed
 * both ways.
 *
 * `id` comes from the SSE `id:` line (the outbox row's serial) and is checked
 * against the contract's own field schema, so a frame that reaches a consumer
 * always carries a positive integer cursor for `replay-anchor` to record.
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
  // Two checks on the literal below, and they cover different things — do not
  // read either as covering the other:
  //
  // `satisfies EventFrame` covers envelope **field presence and field types, for
  // required fields only**. It is what makes a *required* field added to
  // `eventFrameSchema` a compile error here (TS2741) instead of an `undefined`
  // typed `string` at every consumer. Without it, the `as` alone accepts a
  // literal that omits a field outright, because a cast needs only one-way
  // comparability — a *renamed* field errors and a *missing* one does not.
  //
  // The residual, probed and accepted: an **optional** field added to
  // `eventFrameSchema` fires nothing here, and a consumer then reads `undefined`
  // off a type that permits it. `eventFrameSchema` declares no optional field
  // today, so nothing is reachable; an author who adds one gets no help from this
  // line.
  //
  // The `as` covers **only the `kind` ↔ `payload` pairing**, and it says nothing
  // SAFETY: about the payload's own shape: the contract types `payload` as
  // `z.unknown()`,
  // so `satisfies EventFrame` cannot check that pairing and the per-kind table in
  // `frame.test.ts` is what pins it. The cast is needed because TypeScript will
  // not distribute a generic indexed access, so `payload.data` widens to the
  // union of *every* kind's payload even though `eventPayloadSchemas[kind]`
  // produced it. Nothing may re-derive or shadow `kind` between that lookup and
  // this literal.
  return {
    id: id.data,
    kind,
    payload: payload.data,
    createdAt: getStringPath(parsed, "createdAt") ?? "",
  } satisfies EventFrame as Extract<EventStreamFrame, { kind: K }>;
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
 *
 * One case this does **not** close, established by probe in review: `keyof` over
 * a union is the *intersection* of its members' keys, so a payload schema that is
 * a `z.union`/`z.discriminatedUnion` carrying `threadId` on only some variants is
 * classified threadless, reaches `noThreadNamed`, and compiles clean — un-gated.
 * No entry in `eventPayloadSchemas` is a union today and none is planned, and a
 * reducer arm would also have to be added before it could bite. Closing it for
 * real means asserting every entry is a `z.ZodObject`, which is queued rather
 * than done here; the point of this paragraph is that the set's coverage is
 * derived from *flat object* schemas, not from any schema shape.
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
