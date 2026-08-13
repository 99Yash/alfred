/**
 * Compile-only fixture: `SseFrame.event` is a CLOSED union, and the compiler is
 * the gate on it.
 *
 * An SSE frame ends at a blank line, so an event name that holds a line break
 * terminates the frame early and lets the payload write a second frame of its
 * own. The primitive used to answer that input with a `TypeError` from inside
 * `frame()`. That throw landed in the wrong place: `packages/http/src/realtime/
 * events.ts` calls `frame()` from inside the `subscribeUserEvents` listener, and
 * `EventEmitter.emit` propagates a listener throw to its own caller, so the
 * `TypeError` would abort the bus dispatch in `packages/assistant/src/realtime/
 * user-events-bus.ts` and take the other subscribers on that same emit with it.
 *
 * So the field admits only the names the routes in this package send —
 * `EventKind | "poke"` — and none of them holds a line break. A bad name is a
 * compile error at the call site instead of a throw at write time, and `frame()`
 * no longer throws for any input, which is what makes it safe to call from a
 * listener.
 *
 * This fixture fails CLOSED. Widen `event` back to `string` and every
 * `@ts-expect-error` below goes UNUSED, which `check-types` reports as an error,
 * so a green run is evidence the gate is real rather than an assumption that it
 * is. Delete the union and the fixture reddens; that is the point.
 *
 * `packages/http` is the home because its `check-types` runs a second
 * `tsc -p tsconfig.test.json` pass (`include: ["src", "test"]`) over this tree,
 * which is the whole mechanism. The `http-tests` job never runs this file: the
 * `test` script globs `.test.ts` files under `test/`, and this name ends in
 * `-test.ts`, so the glob does not match it. Same argument as
 * `test/type/knowledge-subpath-surface.type-test.ts`.
 *
 * Every declaration a `@ts-expect-error` sits above is exported, because
 * `noUnusedLocals` reports an unread module-scope binding, and an assignment is
 * the only form that puts the error a `@ts-expect-error` needs on the line. The
 * one unexported binding, `nameBuiltAtRunTime`, is read by the declaration below
 * it, so it needs no export of its own.
 */

import type { EventKind } from "@alfred/contracts/events";

import type { SseFrame } from "../../src/realtime/sse";

/**
 * The field under test, read off the interface so the two cannot drift. It is
 * deliberately not the exported `SseEventName` alias: this pins the FIELD, so
 * widening `event` back to `string` reddens this file even if the alias survives
 * beside it. The two also differ — the field adds `| undefined`.
 */
type SseFrameEventField = SseFrame["event"];

/**
 * The positive half, so the negatives below cannot pass by naming something
 * that failed for an unrelated reason. Both live producers are covered: every
 * `kind` on an `EventFrame` (`realtime/events.ts`) and the Replicache poke
 * literal (`sync/replicache.ts`).
 */
export const eventKindIsAnEventName: SseFrameEventField = "agent.progress" satisfies EventKind;
export const pokeIsAnEventName: SseFrameEventField = "poke";

/**
 * The injection string the deleted `TypeError` existed to reject. It is now
 * rejected one step earlier, by the compiler, at the call site.
 */
// @ts-expect-error - a name holding a line break is not in the union.
export const lineBreakIsRejected: SseFrameEventField = "poke\ndata: injected\n";

/**
 * The door this item exists to close: a future route that builds its event name
 * at run time. While the field was `string`, such a route walked straight
 * through. Now it does not compile, and the writer must add the literal to
 * `SseEventName` or re-open sanitisation on purpose.
 */
const nameBuiltAtRunTime: string = "poke";
// @ts-expect-error - `string` is wider than the union; a dynamic name cannot pass.
export const dynamicNameIsRejected: SseFrameEventField = nameBuiltAtRunTime;

/**
 * A plausible name that no route sends. The union is the set of names that
 * exist, not a line-break filter, so a typo in a hand-written literal is also a
 * compile error.
 */
// @ts-expect-error - no route sends this name; it is not in the union.
export const unsentNameIsRejected: SseFrameEventField = "replicache.poke";
