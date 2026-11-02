import {
  assertNever,
  getStringPath,
  httpErrorFromResponse,
  isRecord,
  weatherFallbackFor,
  type IanaTimezone,
  type MemorySource,
  type Place,
  type PlaceArea,
} from "@alfred/contracts";
import type { UserSettings } from "@alfred/assistant/settings";
import { logger } from "@alfred/logging";
import { z } from "zod";
import { recallActiveByKey, type FactRow } from "./facts";

/** A confirmed fact that names the user's place, in the user's words. */
export interface StatedPlace {
  readonly key: "home_city" | "location";
  /** At most `PLACE_TEXT_MAX` characters. */
  readonly text: string;
}

/**
 * The user's place (ADR-0117 decision 3). This is the one reader for every server consumer, as
 * `settings({ userId }).timezone()` is for the zone. A default never wins over a confirmed fact:
 *
 * 1. `preference`: the `location` preference that the user set.
 * 2. `home_fact`: the confirmed `home_city` fact, geocoded and checked against `home_country`.
 * 3. `location_fact`: the confirmed free-text `location` fact ("City / region they're based in"),
 *    geocoded. It is after `home_city` because it is free text, and `home_city` names a city.
 * 4. `timezone_default`: the city that `weatherFallbackFor` maps the zone to. A consumer must
 *    mark a value from this place as a fallback.
 * 5. `none`: Alfred knows no place.
 *
 * A confirmed fact that the geocode does not match goes on to the next step. Then `unplaced` names
 * the first such fact: the default won over a confirmed fact, which is a defect for the operator
 * log (decision 3), not "no city". `fault`: a fact read or a geocode failed. That is temporary, so
 * the reader does not go on to a default.
 */
export type UserLocation =
  | { readonly basis: "preference"; readonly place: Place }
  | {
      readonly basis: "home_fact" | "location_fact";
      readonly place: Place;
      readonly stated: StatedPlace;
    }
  | {
      readonly basis: "timezone_default";
      readonly place: Place;
      readonly unplaced: StatedPlace | null;
    }
  | { readonly basis: "none"; readonly unplaced: StatedPlace | null }
  | { readonly basis: "fault"; readonly step: "fact_read" }
  | { readonly basis: "fault"; readonly step: "geocode"; readonly stated: StatedPlace };

/**
 * `signal`: the caller's deadline. The geocode also stops at `GEOCODE_TIMEOUT_MS`. The reader
 * does not throw: each fault is the `fault` basis, and a log line under `err`.
 */
export async function readUserLocation(args: {
  userId: string;
  settings: UserSettings;
  timezone: IanaTimezone;
  signal?: AbortSignal | undefined;
}): Promise<UserLocation> {
  let preference: Place | null;
  let queries: readonly GeocodeQuery[];

  try {
    [preference, queries] = await Promise.all([
      args.settings.get("location").then((row) => parseStoredLocation(row?.value)),
      readPlaceFacts(args.userId),
    ]);
  } catch (err) {
    logger.warn({ err, userId: args.userId }, "[location] place facts read failed");

    return { basis: "fault", step: "fact_read" };
  }

  if (preference) return { basis: "preference", place: preference };

  let unplaced: StatedPlace | null = null;

  for (const query of queries) {
    const found = await geocode(args.userId, query, args.signal);

    switch (found.kind) {
      case "placed":
        return { basis: query.basis, place: found.place, stated: query.stated };
      case "no_match":
        unplaced ??= query.stated;
        break;
      case "fault":
        return { basis: "fault", step: "geocode", stated: query.stated };
      default:
        return assertNever(found, "geocode result");
    }
  }

  const fallback = weatherFallbackFor(args.timezone);

  return fallback
    ? { basis: "timezone_default", place: fallback, unplaced }
    : { basis: "none", unplaced };
}

/**
 * The user's place in the user's own words, for a consumer that needs a name and not
 * coordinates (chat). A time-zone default is not the user's place, so it gives `null`. A
 * confirmed fact that Alfred could not place is still the user's word, so it gives the fact.
 */
export function statedLocationLabel(located: UserLocation): string | null {
  switch (located.basis) {
    case "preference":
      return located.place.label;
    case "home_fact":
    case "location_fact":
      return located.stated.text;
    case "fault":
      return located.step === "geocode" ? located.stated.text : null;
    case "timezone_default":
    case "none":
      return located.unplaced?.text ?? null;
    default:
      return assertNever(located, "user location basis");
  }
}

/**
 * The one rule for a confirmed identity fact that is the user's own word: the user, cold start,
 * the agent, or a document that the user wrote. The profile and the place reader share it.
 */
export function isUserStatedSource(source: MemorySource): boolean {
  switch (source.kind) {
    case "user":
    case "cold_start":
    case "agent":
      return true;
    case "document":
      return source.meta?.documentAuthoredByUser === true;
    case "chunk":
    case "tool_call":
      return false;
    default:
      return assertNever(source.kind, "memory source kind");
  }
}

/** A stored coordinate: a number, or a string `parseFloat` reads. `z.number()` rejects NaN and Infinity. */
const storedCoordSchema = z
  .union([z.number(), z.string().transform((value) => Number.parseFloat(value))])
  .pipe(z.number());

function parseStoredLocation(value: unknown): Place | null {
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

/**
 * Longest fact text that the reader treats as a place. The longest official place name has 85
 * characters, and "city, region, country" fits in 100. A longer value is not a place name (a cold
 * start fact can hold 2,000 characters), and the text goes into a bounded provenance reason.
 */
const PLACE_TEXT_MAX = 100;

const factTextSchema = z.string().trim().min(1);

/** Rows to read for one key. The newest row that the user stated wins. */
const PLACE_FACT_CANDIDATES = 10;

/**
 * Open-Meteo answers a name search in well under a second. Five seconds covers a slow network,
 * and a chat turn waits for it at most one time in each process for each fact value.
 */
const GEOCODE_TIMEOUT_MS = 5_000;

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
        country_code: z.string().optional(),
        admin1: z.string().optional(),
        admin2: z.string().optional(),
      }),
    )
    .optional(),
});

type GeocodeCandidate = NonNullable<z.infer<typeof geocodeResponseSchema>["results"]>[number];

/**
 * One name to geocode. `country`: the `home_country` fact; a match must be in that country.
 * `qualifiers`: the parts after the first comma of a free-text fact; a match must have one of
 * them as its country or its first-level region.
 */
interface GeocodeQuery {
  readonly basis: "home_fact" | "location_fact";
  readonly stated: StatedPlace;
  readonly name: string;
  readonly country: string | null;
  readonly qualifiers: readonly string[];
}

/** The confirmed place facts, in the order of decision 3. A DB fault throws to the reader. */
async function readPlaceFacts(userId: string): Promise<GeocodeQuery[]> {
  const [cityRows, countryRows, locationRows] = await Promise.all([
    recallActiveByKey(userId, "home_city", { limit: PLACE_FACT_CANDIDATES }),
    recallActiveByKey(userId, "home_country", { limit: PLACE_FACT_CANDIDATES }),
    recallActiveByKey(userId, "location", { limit: PLACE_FACT_CANDIDATES }),
  ]);

  const city = statedFactText(userId, "home_city", cityRows);
  const country = statedFactText(userId, "home_country", countryRows);
  const location = statedFactText(userId, "location", locationRows);
  const queries: GeocodeQuery[] = [];

  if (city) {
    queries.push({
      basis: "home_fact",
      stated: { key: "home_city", text: city },
      name: city,
      country,
      qualifiers: [],
    });
  }

  if (location) {
    const [name = location, ...qualifiers] = location
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    queries.push({
      basis: "location_fact",
      stated: { key: "location", text: location },
      name,
      country: null,
      qualifiers,
    });
  }

  return queries;
}

/** The newest row that the user stated, as text inside `PLACE_TEXT_MAX`. */
function statedFactText(userId: string, key: string, rows: readonly FactRow[]): string | null {
  const row = rows.find((candidate) => isUserStatedSource(candidate.source));
  const text = factTextSchema.safeParse(row?.value);

  if (!text.success) return null;

  if (text.data.length > PLACE_TEXT_MAX) {
    logger.warn(
      { userId, key, length: text.data.length },
      "[location] place fact is too long to be a place name; not read",
    );

    return null;
  }

  return text.data;
}

type GeocodeResult =
  | { readonly kind: "placed"; readonly place: Place }
  | { readonly kind: "no_match" }
  | { readonly kind: "fault" };

/**
 * The place of each query that this process has geocoded; `null` is a miss. The ADR asks to keep
 * the geocode with the fact. `user_facts` has no column for it, and a preference row would show
 * on the Preferences page, so the process keeps it. A restart costs one more request.
 */
const geocoded = new Map<string, Place | null>();

async function geocode(
  userId: string,
  query: GeocodeQuery,
  signal: AbortSignal | undefined,
): Promise<GeocodeResult> {
  const key = [query.name, query.country ?? "", ...query.qualifiers].join("|").toLowerCase();
  const cached = geocoded.get(key);

  if (cached !== undefined)
    return cached ? { kind: "placed", place: cached } : { kind: "no_match" };

  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query.name);
    url.searchParams.set("count", String(GEOCODE_CANDIDATES));
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const deadline = AbortSignal.any([
      AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);

    const res = await fetch(url, { signal: deadline });

    if (!res.ok) throw await httpErrorFromResponse("open-meteo-geocoding", res);

    const { results = [] } = geocodeResponseSchema.parse(await res.json());
    const match = results.find((candidate) => matchesQuery(candidate, query));

    const place = match ? placeOf(match) : null;

    // Keep a miss too: the same fact gives the same miss until the fact changes.
    geocoded.set(key, place);

    if (!place) {
      logger.warn(
        { userId, key: query.stated.key, name: query.name, country: query.country },
        "[location] place fact has no geocode match",
      );

      return { kind: "no_match" };
    }

    return { kind: "placed", place };
  } catch (err) {
    // Not kept: a network fault can pass, so the next read tries again.
    logger.warn({ err, userId, key: query.stated.key }, "[location] place fact geocode failed");

    return { kind: "fault" };
  }
}

/**
 * The candidate as a place. The administrative areas go with it, so a national warning feed can
 * match the place by its district (ADR-0117 decision 4).
 */
function placeOf(match: GeocodeCandidate): Place {
  const area: PlaceArea | undefined = match.country_code
    ? {
        countryCode: match.country_code.toUpperCase(),
        ...(match.admin1 ? { region: match.admin1 } : {}),
        ...(match.admin2 ? { district: match.admin2 } : {}),
      }
    : undefined;

  return {
    lat: match.latitude,
    lng: match.longitude,
    label: match.country ? `${match.name}, ${match.country}` : match.name,
    ...(area ? { area } : {}),
  };
}

/**
 * With no country and no qualifier, Open-Meteo's top-ranked match counts. Otherwise the first
 * candidate in the stated country, or with a qualifier as its country or first-level region.
 */
function matchesQuery(candidate: GeocodeCandidate, query: GeocodeQuery): boolean {
  if (query.country !== null) return inCountry(candidate, query.country);

  if (query.qualifiers.length === 0) return true;

  return query.qualifiers.some(
    (qualifier) =>
      inCountry(candidate, qualifier) ||
      (candidate.admin1 !== undefined && sameName(candidate.admin1, qualifier)),
  );
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** A two-letter or three-digit region code, the forms that `Intl.DisplayNames` accepts. */
const REGION_CODE = /^(?:[a-z]{2}|\d{3})$/i;

/** The English name of a region code ("US", or "UK", which ICU reads as "GB"), else `null`. */
function regionName(code: string): string | null {
  return REGION_CODE.test(code) ? (regionNames.of(code.toUpperCase()) ?? null) : null;
}

/** The stated country as a name or an ISO code, against the candidate's name and code. */
function inCountry(candidate: GeocodeCandidate, stated: string): boolean {
  const statedName = regionName(stated) ?? stated;

  if (candidate.country !== undefined && sameName(candidate.country, statedName)) return true;

  const codeName = candidate.country_code ? regionName(candidate.country_code) : null;

  return codeName !== null && sameName(codeName, statedName);
}

/** Case and accent do not count ("Sao Paulo" is "São Paulo"). */
function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, "en", { sensitivity: "base" }) === 0;
}
