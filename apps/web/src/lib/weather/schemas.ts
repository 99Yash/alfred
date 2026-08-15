/**
 * Weather shapes for the rail: the persisted snapshot contract plus the wire
 * schemas for the three providers it is assembled from.
 *
 * `weatherSnapshotSchema` is the source of truth for the snapshot's shape and
 * validates the persisted cache via the storage registry
 * (`lib/storage/storage-schemas.ts`). The provider schemas validate untrusted
 * response JSON at the fetch boundary (`index.ts`) instead of casting it —
 * the `@alfred/contracts` "parse, don't assert" rule, applied locally because
 * `apps/web` cannot import server packages.
 */

import { z } from "zod";

export const weatherConditionSchema = z.enum([
  "clear",
  "partly_cloudy",
  "cloudy",
  "fog",
  "rain",
  "snow",
  "storm",
  "unknown",
]);
export type WeatherCondition = z.infer<typeof weatherConditionSchema>;

const temperatureUnitSchema = z.enum(["C", "F"]);
export type TemperatureUnit = z.infer<typeof temperatureUnitSchema>;

/**
 * Schema is the source of truth for the snapshot's shape — it also validates
 * the persisted weather cache (see `lib/storage`'s registry). Field notes:
 *   - `temperature`: whole-degree temperature in `unit`.
 *   - `city`: city name (or region, when geojs can't resolve a city).
 *   - `isDay`: `true` when open-meteo reports daylight at the resolved
 *     coordinates. Drives the night-video swap in the rail. Missing data
 *     defaults to `true` (daytime) in the open-meteo transform so a flaky
 *     `is_day` field never paints the surface black for a daytime user.
 */
export const weatherSnapshotSchema = z.object({
  temperature: z.number(),
  unit: temperatureUnitSchema,
  city: z.string(),
  condition: weatherConditionSchema,
  isDay: z.boolean(),
});
export type WeatherSnapshot = z.infer<typeof weatherSnapshotSchema>;

/**
 * A coordinate as geojs reports it — a number or a numeric string. The
 * transform normalizes both to a number; anything else fails the parse.
 */
const coordinateSchema = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform((value) => (typeof value === "string" ? Number.parseFloat(value) : value));

/**
 * `get.geojs.io/v1/ip/geo.json` — the coarse IP fallback. Every field is
 * optional: the schema only rejects garbage; `ipLocation` still checks that
 * a location is complete before using it.
 */
export const geoJsLocationSchema = z.object({
  latitude: coordinateSchema.optional(),
  longitude: coordinateSchema.optional(),
  city: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

/**
 * `api.bigdatacloud.net/data/reverse-geocode-client` — coordinates → name.
 * The caller takes the first present of city / locality / region; when none
 * resolve it keeps the coordinates with a coordinate label instead.
 */
export const bigDataCloudReverseSchema = z.object({
  city: z.string().min(1).optional(),
  locality: z.string().min(1).optional(),
  principalSubdivision: z.string().min(1).optional(),
});

/**
 * WMO weather codes (open-meteo's `weather_code`):
 *   0       = clear
 *   1-2     = mainly clear / partly cloudy → `partly_cloudy`
 *   3       = overcast → `cloudy`
 *   45-48   = fog
 *   51-67   = drizzle / rain
 *   71-77   = snow
 *   80-82   = rain showers
 *   85-86   = snow showers
 *   95-99   = thunderstorm
 *
 * 1-2 are split from 3 so the rail can pick the partly-cloudy loop (lively,
 * sunlit) for "mainly clear" weather and reserve the heavier overcast loop
 * for true overcast — matches dimension's split. First matching band wins;
 * an absent or unrecognized code maps to `unknown`.
 */
const WMO_CODE_BANDS: ReadonlyArray<{ from: number; to: number; condition: WeatherCondition }> = [
  { from: 0, to: 0, condition: "clear" },
  { from: 1, to: 2, condition: "partly_cloudy" },
  { from: 3, to: 3, condition: "cloudy" },
  { from: 45, to: 48, condition: "fog" },
  { from: 51, to: 67, condition: "rain" },
  { from: 71, to: 77, condition: "snow" },
  { from: 80, to: 82, condition: "rain" },
  { from: 85, to: 86, condition: "snow" },
  { from: 95, to: 99, condition: "storm" },
];

export function wmoCodeToCondition(code: number | null | undefined): WeatherCondition {
  if (code === undefined || code === null) return "unknown";
  return (
    WMO_CODE_BANDS.find((band) => code >= band.from && code <= band.to)?.condition ?? "unknown"
  );
}

/**
 * `api.open-meteo.com/v1/forecast` current block, transformed to the snapshot
 * fields it feeds. The transform is the wire→domain mapping: temperature
 * rounds to whole degrees, `weather_code` maps through the WMO bands, and
 * `is_day` becomes the rail's daytime flag. A missing `is_day` (or any
 * non-night value) reads as daytime so a flaky field never shows the night
 * video to a daytime user.
 */
export const openMeteoResponseSchema = z.object({
  current: z
    .object({
      temperature_2m: z.number(),
      weather_code: z.number().nullish(),
      is_day: z.union([z.literal(1), z.literal(0), z.boolean()]).nullish(),
    })
    .transform((current) => ({
      temperature: Math.round(current.temperature_2m),
      condition: wmoCodeToCondition(current.weather_code),
      isDay: current.is_day !== 0 && current.is_day !== false,
    }))
    .optional(),
});
