/** The persisted weather snapshot, plus wire schemas for the three providers. */

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

/** Also validates the persisted cache. `isDay` drives the rail's night video. */
export const weatherSnapshotSchema = z.object({
  temperature: z.number(),
  unit: temperatureUnitSchema,
  city: z.string(),
  condition: weatherConditionSchema,
  isDay: z.boolean(),
});

export type WeatherSnapshot = z.infer<typeof weatherSnapshotSchema>;

/** geojs sends a number or a numeric string. */
const coordinateSchema = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform((value) => (typeof value === "string" ? Number.parseFloat(value) : value));

/** All optional; `ipLocation` checks completeness. */
export const geoJsLocationSchema = z.object({
  latitude: coordinateSchema.optional(),
  longitude: coordinateSchema.optional(),
  city: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

/** BigDataCloud reverse geocode. The caller takes city, then locality, then region. */
export const bigDataCloudReverseSchema = z.object({
  city: z.string().min(1).optional(),
  locality: z.string().min(1).optional(),
  principalSubdivision: z.string().min(1).optional(),
});

/** WMO `weather_code` bands. 1-2 are apart from 3 so "mainly clear" gets the sunlit loop. */
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

/** A missing `is_day` reads as day, so a flaky field never shows night video by day. */
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
