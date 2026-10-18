/**
 * Browser weather: location from geolocation (city via BigDataCloud), else IP via geojs,
 * then open-meteo. IP is a last resort because an ISP can register an IP to another city.
 * Do not use `ipapi.co` without a proxy: its free-tier 429s carry no CORS headers.
 */

import type { z } from "zod";

import {
  bigDataCloudReverseSchema,
  geoJsLocationSchema,
  openMeteoResponseSchema,
  type TemperatureUnit,
  type WeatherSnapshot,
} from "./schemas";

export type { WeatherCondition, WeatherSnapshot } from "./schemas";

export { weatherSnapshotSchema } from "./schemas";

const WEATHER_FETCH_TIMEOUT_MS = 8_000;

const GEOLOCATION_FIX_TIMEOUT_MS = 8_000;

const FAHRENHEIT_REGIONS = new Set(["US", "BS", "BZ", "KY", "PW", "FM", "MH", "LR"]);

interface ResolvedLocation {
  lat: number;
  lon: number;
  /** A city, a region, or a coordinate label. */
  label: string;
}

/** Throws a labeled error on non-2xx, bad JSON, or a body the schema rejects. */
async function fetchJson<T>(url: URL, source: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });

  if (!res.ok) throw new Error(`${source}: ${res.status}`);
  let body: unknown;

  try {
    body = await res.json();
  } catch {
    throw new Error(`${source}: invalid JSON response`);
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) throw new Error(`${source}: invalid response`);

  return parsed.data;
}

/** Fahrenheit for the listed countries, else Celsius. */
function preferredTemperatureUnit(): TemperatureUnit {
  if (typeof navigator === "undefined") return "C";

  try {
    const raw = new Intl.Locale(navigator.language);
    const region = raw.region ?? raw.maximize().region;

    return region && FAHRENHEIT_REGIONS.has(region) ? "F" : "C";
  } catch {
    return "C";
  }
}

/** `null` on any failure, which means "fall back to IP". Accepts a fix up to 10 minutes old. */
function getBrowserCoords(): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;

        // (0,0) means "no fix yet" (Chrome on macOS), not a place. Fall back to IP.
        if (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1) {
          resolve(null);

          return;
        }

        resolve({ lat, lon });
      },
      () => resolve(null),
      {
        enableHighAccuracy: false,
        timeout: GEOLOCATION_FIX_TIMEOUT_MS,
        maximumAge: 10 * 60 * 1000,
      },
    );
  });
}

/** City name for coordinates, or `null` on any failure. */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("localityLanguage", "en");

    const { city, locality, principalSubdivision } = await fetchJson(
      url,
      "bigdatacloud",
      bigDataCloudReverseSchema,
    );

    return city ?? locality ?? principalSubdivision ?? null;
  } catch {
    return null;
  }
}

/** Coarse IP location. */
async function ipLocation(): Promise<ResolvedLocation> {
  const { latitude, longitude, city, region } = await fetchJson(
    new URL("https://get.geojs.io/v1/ip/geo.json"),
    "geojs",
    geoJsLocationSchema,
  );

  const label = city ?? region;

  if (latitude === undefined || longitude === undefined || label === undefined) {
    throw new Error("geojs: incomplete location");
  }

  return { lat: latitude, lon: longitude, label };
}

/** Keep real coordinates even without a city name; a coordinate label beats a wrong city. */
async function resolveLocation(): Promise<ResolvedLocation> {
  const coords = await getBrowserCoords();

  if (coords) {
    const city = await reverseGeocode(coords.lat, coords.lon);

    return {
      lat: coords.lat,
      lon: coords.lon,
      label: city ?? `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
    };
  }

  return ipLocation();
}

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const { lat, lon, label } = await resolveLocation();

  const unit = preferredTemperatureUnit();
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");

  if (unit === "F") url.searchParams.set("temperature_unit", "fahrenheit");

  const { current } = await fetchJson(url, "open-meteo", openMeteoResponseSchema);

  if (!current) throw new Error("open-meteo: invalid response");

  return { ...current, unit, city: label };
}
