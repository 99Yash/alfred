import {
  getStringPath,
  isRecord,
  weatherFallbackFor,
  type IanaTimezone,
  type WeatherFallbackLocation,
} from "@alfred/contracts";
import type { UserSettings } from "@alfred/assistant/settings";
import { logger } from "@alfred/logging";
import { z } from "zod";
import { recallLatestByKey } from "./facts";

/**
 * The user's place (ADR-0117 decision 3). This is the one reader for every server consumer, as
 * `settings({ userId }).timezone()` is for the zone. A default never wins over a confirmed fact:
 *
 * 1. `preference`: the `location` preference that the user set.
 * 2. `home_fact`: the confirmed `home_city` fact, geocoded and checked against `home_country`.
 * 3. `timezone_default`: the city that `weatherFallbackFor` maps the zone to. A consumer must
 *    mark a value from this place as a fallback.
 * 4. `none`: Alfred knows no place.
 *
 * A geocode failure is a log line, and the reader goes on to the time-zone default. Then
 * `unplacedCity` names the confirmed city that Alfred could not place: the default won over a
 * confirmed fact, which is a defect for the operator log (decision 3), not "no city".
 */
export type UserLocation =
  | {
      readonly basis: "preference" | "home_fact";
      readonly place: WeatherFallbackLocation;
    }
  | {
      readonly basis: "timezone_default";
      readonly place: WeatherFallbackLocation;
      readonly unplacedCity: string | null;
    }
  | { readonly basis: "none"; readonly unplacedCity: string | null };

export async function readUserLocation(args: {
  userId: string;
  settings: UserSettings;
  timezone: IanaTimezone;
}): Promise<UserLocation> {
  const preference = parseStoredLocation((await args.settings.get("location"))?.value);

  if (preference) return { basis: "preference", place: preference };

  const home = await geocodeHomeFact(args.userId);

  if (home.place) return { basis: "home_fact", place: home.place };

  const fallback = weatherFallbackFor(args.timezone);

  return fallback
    ? { basis: "timezone_default", place: fallback, unplacedCity: home.city }
    : { basis: "none", unplacedCity: home.city };
}

/** A stored coordinate: a number, or a string `parseFloat` reads. `z.number()` rejects NaN and Infinity. */
const storedCoordSchema = z
  .union([z.number(), z.string().transform((value) => Number.parseFloat(value))])
  .pipe(z.number());

function parseStoredLocation(value: unknown): WeatherFallbackLocation | null {
  if (!isRecord(value)) return null;
  const lat = storedCoordSchema.safeParse(value.lat ?? value.latitude);
  const lng = storedCoordSchema.safeParse(value.lng ?? value.lon ?? value.longitude);

  if (!lat.success || !lng.success) return null;

  const label =
    getStringPath(value, "label") ??
    getStringPath(value, "city") ??
    getStringPath(value, "name") ??
    `${lat.data},${lng.data}`;

  return { lat: lat.data, lng: lng.data, label };
}

const factTextSchema = z.string().trim().min(1);

const GEOCODE_TIMEOUT_MS = 10_000;

/** Candidates to read for one name. Several cities share a name (Bhubaneswar is also in Bangladesh). */
const GEOCODE_CANDIDATES = 10;

const geocodeResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * The place of each `city|country` pair that this process has geocoded. The ADR asks to keep the
 * geocode with the fact. `user_facts` has no column for it, and a preference row would show on
 * the Preferences page, so the process keeps it. A restart costs one more request.
 */
const geocodedHomes = new Map<string, WeatherFallbackLocation | null>();

/** The confirmed home city, if any, and its place, if the geocode found one. */
async function geocodeHomeFact(
  userId: string,
): Promise<{ city: string | null; place: WeatherFallbackLocation | null }> {
  const [cityFact, countryFact] = await Promise.all([
    recallLatestByKey(userId, "home_city"),
    recallLatestByKey(userId, "home_country"),
  ]);

  const city = factTextSchema.safeParse(cityFact?.value);

  if (!city.success) return { city: null, place: null };
  const country = factTextSchema.safeParse(countryFact?.value);
  const countryName = country.success ? country.data : null;
  const key = `${city.data.toLowerCase()}|${countryName?.toLowerCase() ?? ""}`;

  if (geocodedHomes.has(key)) return { city: city.data, place: geocodedHomes.get(key) ?? null };

  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", city.data);
    url.searchParams.set("count", String(GEOCODE_CANDIDATES));
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });

    if (!res.ok) throw new Error(`[location.geocode] ${res.status}`);

    const { results = [] } = geocodeResponseSchema.parse(await res.json());

    // With a country fact, only a result in that country counts. Without one, the first result
    // is the most populous match.
    const match = countryName
      ? results.find((r) => r.country?.toLowerCase() === countryName.toLowerCase())
      : results[0];

    const place = match
      ? {
          lat: match.latitude,
          lng: match.longitude,
          label: match.country ? `${match.name}, ${match.country}` : match.name,
        }
      : null;

    // Keep a miss too: the same fact gives the same miss until the fact changes.
    geocodedHomes.set(key, place);

    if (!place) {
      logger.warn(
        { userId, city: city.data, country: countryName },
        "[location] home city has no geocode match",
      );
    }

    return { city: city.data, place };
  } catch (err) {
    // Not kept: a network fault can pass, so the next read tries again.
    logger.warn(
      { err, userId },
      "[location] home city geocode failed; using the time-zone default",
    );

    return { city: city.data, place: null };
  }
}
