/**
 * Compile-only fixture: `SseFrame.event` is a closed union (`EventKind | "poke"`).
 * A line break in an event name ends the SSE frame early and injects a second one.
 * The compiler rejects bad names, so `frame()` never throws inside a bus listener.
 * Widen `event` to `string` and every `@ts-expect-error` below goes unused.
 */

import type { EventKind } from "@alfred/contracts/events";

import type { SseFrame } from "../../src/realtime/sse";

/** Pin the field, not the `SseEventName` alias, so widening the field fails here. */
type SseFrameEventField = SseFrame["event"];

// Positive cases from both producers, so the negatives cannot pass by accident.
export const eventKindIsAnEventName: SseFrameEventField = "agent.progress" satisfies EventKind;

export const pokeIsAnEventName: SseFrameEventField = "poke";

// @ts-expect-error - a name holding a line break is not in the union.
export const lineBreakIsRejected: SseFrameEventField = "poke\ndata: injected\n";

// A route that builds its event name at run time must not compile.
const nameBuiltAtRunTime: string = "poke";

// @ts-expect-error - `string` is wider than the union; a dynamic name cannot pass.
export const dynamicNameIsRejected: SseFrameEventField = nameBuiltAtRunTime;

// The union is the set of sent names, so a typo also fails.
// @ts-expect-error - no route sends this name; it is not in the union.
export const unsentNameIsRejected: SseFrameEventField = "replicache.poke";
