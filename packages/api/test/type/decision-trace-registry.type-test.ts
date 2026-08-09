// Tier-4 negative-type fixture guarding the augmentable `DecisionTraceRegistry`
// (#219 PR-A follow-up). The registry is deliberately an EMPTY, OPEN interface
// that each producer module augments from inside its own boundary
// (`agent/decision-traces.ts`), so `ctx.trace(kind, record)` stays generic over
// it without execution importing any product payload type. The one way that
// design silently erodes: someone widens the registry to an index signature
// (`[k: string]: unknown`) or widens an entry to `unknown` to "make an error go
// away" — which would accept ANY payload for ANY kind and quietly demote the
// tier-1 payload guarantee to a docstring warning.
//
// This file is that guarantee's machine detector. It is compile-only: the
// node:test glob is `test/**/*.test.ts`, so a `.type-test.ts` never runs; it is
// type-checked solely by `packages/api/tsconfig.test.json` (wired into
// `check-types`). If a future widening makes a wrong payload compile, the
// `@ts-expect-error` directives below become unused and `tsc` fails with TS2578
// — the regression turns the build red.

import type { DecisionTraceFor } from "@alfred/assistant/execution/decision-traces";
import type { StepContext } from "@alfred/assistant/execution/types";
// Barrel import (triage/index.ts). `SenderExtractionEvent` is the payload triage
// declares for `"triage.classification"` via a `declare module` augmentation at
// the bottom of `triage/sender-extraction-event.ts`; because `tsconfig.test.json`
// includes `src`, that augmentation is active in this program unconditionally.
import type { SenderExtractionEvent } from "../../src/modules/triage";

// `declare const` is ambient, so `noUnusedLocals`/`noUnusedParameters` never fire
// on these; the `export const` fixtures below are exported for the same reason
// (matching the established `.type-test.ts` idiom in `@alfred/sync`).
declare const ctx: StepContext<unknown>;
declare const validEvent: SenderExtractionEvent;

// POSITIVE — proves the augmentation is loaded and the negatives below fail for
// the RIGHT reason (payload shape), not because `"triage.classification"` is an
// unknown key. If triage's augmentation were absent, the registry would be empty,
// `DecisionTraceKind` would be `never`, and BOTH of these would fail to compile —
// failing the build here rather than passing a hollow negative test.
ctx.trace("triage.classification", validEvent);
export const _ok: DecisionTraceFor<"triage.classification"> = validEvent;

// NEGATIVE (payload) — a payload that is not a `SenderExtractionEvent` must not
// satisfy the kind. Asserted both through the `ctx.trace` call surface and
// directly on the tier-1 `DecisionTraceFor<K>` the Report gate names. This is
// the detector for a future widening of the ENTRY to `unknown`
// (`"triage.classification": unknown`): that makes `DecisionTraceFor<K>` accept
// anything, both directives below go unused, and `tsc` fails with TS2578.
// @ts-expect-error wrong payload shape for "triage.classification" must fail to compile (guards widening the "triage.classification" entry to `unknown`)
ctx.trace("triage.classification", { notASenderExtractionEvent: true });
// @ts-expect-error same guarantee asserted directly on DecisionTraceFor<K>: a non-SenderExtractionEvent payload must not be assignable
export const _bad: DecisionTraceFor<"triage.classification"> = { notASenderExtractionEvent: true };

// NEGATIVE (kind closure) — an unregistered kind must NOT be a valid
// `DecisionTraceKind`. This is a SEPARATE guard from the payload negatives above:
// TS explicit-member precedence keeps the augmented "triage.classification" entry
// narrow even if someone adds a base index signature (`[k: string]: unknown`), so
// the payload negatives alone do NOT go red on that mutation. Adding an index
// signature instead widens `keyof DecisionTraceRegistry` to `string | number`, so
// this line's kind stops being an error, the directive goes unused, and `tsc`
// fails with TS2578 — catching the index-signature widening directly at the
// fixture rather than relying on the incidental downstream break in `executor.ts`
// (its `kind` column being a string). A valid payload is passed so the ONLY
// reason this errors under the real registry is the unregistered kind, not a
// payload mismatch — keeping this guard orthogonal to the payload negatives (the
// Report gate forbids relying *merely* on a kind literal, not adding one).
// @ts-expect-error "not.a.registered.kind" is not a declared trace kind (guards widening DecisionTraceRegistry to an index signature `[k: string]: unknown`)
ctx.trace("not.a.registered.kind", validEvent);
