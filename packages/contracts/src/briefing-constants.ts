import { z } from "zod";

/**
 * Briefing defaults that the server and the web must agree on.
 * They apply when the `timezone` (legacy `briefing.timezone`),
 * `briefing.delivery_hour`, and `briefing.evening_hour` prefs are not set.
 */

export const DEFAULT_BRIEFING_TIMEZONE = "UTC";

export const DEFAULT_BRIEFING_DELIVERY_HOUR = 7;

export const DEFAULT_BRIEFING_EVENING_HOUR = 18;

/** Hour 0-23 in the user's zone. Coerces, because synced and legacy prefs can be strings. */
export const briefingHourSchema = z.coerce.number().int().min(0).max(23);

export type BriefingHour = z.infer<typeof briefingHourSchema>;
