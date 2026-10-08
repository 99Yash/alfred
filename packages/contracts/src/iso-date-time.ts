import { z } from "zod";

/** A wire timestamp string. Accepts exactly what `new Date(...)` can read. */
export const isoDateTimeStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid date-time string",
  });

/**
 * Let the process exit while this Node timer is still pending. Idempotent.
 * No browser check: server packages do not compile with the DOM lib.
 */
export function unrefTimer(timer: { unref(): void }): void {
  timer.unref();
}
