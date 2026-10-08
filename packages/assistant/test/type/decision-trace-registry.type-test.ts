// Compile-only fixture for the open `DecisionTraceRegistry` in `execution/decision-traces.ts`.
// Producers augment it from their own modules. If someone widens it to an index signature,
// or an entry to `unknown`, a directive below goes unused and `tsc` fails with TS2578.

import type { DecisionTraceFor } from "@alfred/assistant/execution/decision-traces";
import type { StepContext } from "@alfred/assistant/execution";
// Triage augments `"triage.classification"` with this payload via `declare module`; `tsconfig.test.json` includes `src`.
import type { SenderExtractionEvent } from "@alfred/assistant/triage";

// `declare const` is ambient, so the unused-locals checks do not fire.
declare const ctx: StepContext<unknown>;

declare const validEvent: SenderExtractionEvent;

// Positive: proves the augmentation loaded, so the negatives fail on payload shape, not an unknown kind.
ctx.trace("triage.classification", validEvent);

export const _ok: DecisionTraceFor<"triage.classification"> = validEvent;

// Payload negatives: guard against widening the entry to `unknown`.
// @ts-expect-error wrong payload shape for "triage.classification" must fail to compile (guards widening the "triage.classification" entry to `unknown`)
ctx.trace("triage.classification", { notASenderExtractionEvent: true });

// @ts-expect-error same guarantee asserted directly on DecisionTraceFor<K>: a non-SenderExtractionEvent payload must not be assignable
export const _bad: DecisionTraceFor<"triage.classification"> = { notASenderExtractionEvent: true };

// Kind negative: a separate guard. An index signature keeps the explicit entry narrow, so the payload
// negatives stay green, but `keyof` widens to `string | number` and this directive goes unused.
// A valid payload makes the unregistered kind the only error.
// @ts-expect-error "not.a.registered.kind" is not a declared trace kind (guards widening DecisionTraceRegistry to an index signature `[k: string]: unknown`)
ctx.trace("not.a.registered.kind", validEvent);
