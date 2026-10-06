import { z } from "zod";

/**
 * A timestamp as it travels on the wire: an ISO-8601 string, validated by
 * round-tripping it through `Date` rather than by a regex, so the accepted set
 * is exactly what `new Date(...)` can read back.
 *
 * This lived in `@alfred/sync` first, because Replicache rows were the only
 * shapes that needed it. `@alfred/contracts` cannot import `@alfred/sync` (the
 * dependency runs the other way), so the shared-thread publication shapes could
 * not reuse it there. It moves here — the lower package — and `@alfred/sync`
 * re-exports it, so every wire contract keeps one definition instead of two
 * that can drift.
 */
export const isoDateTimeStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid date-time string",
  });

/**
 * Let a Node timer hold the process open.
 *
 * A `setTimeout`/`setInterval` handle keeps the event loop alive until it fires,
 * so a background sweep, a heartbeat, or a shutdown drain that is not actually
 * required for correctness will hold a server (or a script, or a test runner)
 * open for its full interval. `unref()` says "do not wait for me".
 *
 * It used to be spelled, at seven call sites across four packages, as
 * `if (typeof timer === "object" && "unref" in timer) timer.unref();` — a
 * platform capability probe carried by an `eslint-disable-next-line` whose stated
 * rationale was that "browsers return a number". No server package compiles with
 * a DOM lib (`packages/config/tsconfig.base.json` sets `lib: ["ESNext"]` and
 * `types: ["node"]`), and `ReturnType<typeof setTimeout>` there is
 * `NodeJS.Timeout`, which declares `unref(): this`. The probe was therefore
 * provably dead: `tsc` accepts the bare call in every one of those seven
 * packages. `apps/web` is the only project that adds `"DOM"`, and it never holds
 * a Node timer.
 *
 * So the portability the probe defended against cannot occur, and the `typeof`
 * was seven copies of a fact the type system already states. If a future package
 * does compile with the DOM lib, `NodeJS.Timeout` stops being the return type and
 * this call stops typechecking — which is the correct moment to revisit, and a
 * far better signal than a runtime probe that silently skips.
 *
 * Idempotent and safe on an already-unref'd handle, so a caller may call it
 * defensively on a shared timer.
 */
export function unrefTimer(timer: { unref(): void }): void {
  timer.unref();
}
