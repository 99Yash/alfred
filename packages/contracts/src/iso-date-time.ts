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
