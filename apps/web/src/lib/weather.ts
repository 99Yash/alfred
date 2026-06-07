/**
 * Browser-side weather lookup.
 *
 * Location resolves in two tiers (see `resolveLocation`):
 *   1. **Browser geolocation** (`navigator.geolocation`) — the device's
 *      real GPS/WiFi position, reverse-geocoded to a city name via
 *      BigDataCloud. Accurate to the actual location, gated by a one-time
 *      permission prompt. Preferred when granted.
 *   2. **IP geolocation** (`get.geojs.io/v1/ip/geo.json`) — fallback when
 *      the user denies/dismisses the prompt, the device can't get a fix,
 *      or geolocation is unavailable (insecure origin, no sensor). No
 *      permission, no auth, CORS-open. Coarse: it reports whatever city
 *      the ISP registers the IP to, which for residential connections can
 *      be a different city entirely (e.g. a BSNL IP in Bhubaneswar that
 *      registers to Angul). That inaccuracy is exactly why the browser
 *      tier comes first.
 *
 * Weather then comes from `api.open-meteo.com` — current temperature +
 * WMO weather code for the resolved coordinates. No auth, CORS-open.
 *
 * If the weather call fails (network, rate-limit) the caller (react-query)
 * surfaces it; the weather line hides itself.
 *
 * History: we used `ipapi.co` originally — they now serve 429s without
 * CORS headers on the free tier, which the browser reports as a CORS
 * error. Don't reintroduce it without proxying through our API.
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

export const temperatureUnitSchema = z.enum(["C", "F"]);
export type TemperatureUnit = z.infer<typeof temperatureUnitSchema>;

/**
 * Schema is the source of truth for the snapshot's shape — it also validates
 * the persisted weather cache (see `lib/storage`'s registry). Field notes:
 *   - `temperature`: whole-degree temperature in `unit`.
 *   - `city`: city name (or region, when geojs can't resolve a city).
 *   - `isDay`: `true` when open-meteo reports daylight at the resolved
 *     coordinates. Drives the night-video swap in the rail. Missing data
 *     defaults to `true` (daytime) in `fetchWeather` so a flaky `is_day`
 *     field never paints the surface black for a daytime user.
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
 * Pick Celsius or Fahrenheit from the browser's locale. Falls back to C
 * for anything we can't resolve. Countries listed here use Fahrenheit
 * for everyday temperatures.
 */
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

const FAHRENHEIT_REGIONS = new Set(["US", "BS", "BZ", "KY", "PW", "FM", "MH", "LR"]);
const WEATHER_FETCH_TIMEOUT_MS = 8_000;

interface GeoJsLocation {
  city?: unknown;
  region?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

interface BigDataCloudReverse {
  city?: unknown;
  locality?: unknown;
  principalSubdivision?: unknown;
}

interface ResolvedLocation {
  lat: number;
  lon: number;
  city: string;
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: unknown;
    weather_code?: unknown;
    is_day?: unknown;
  };
}

function parseCoord(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Ask the browser for the device's real position. Resolves to `null`
 * (rather than rejecting) on denial, timeout, unavailable sensor, or an
 * insecure origin — every one of those just means "fall back to IP".
 *
 * `maximumAge` accepts a fix up to 10 min old so a returning user isn't
 * re-prompted for a fresh GPS lock; `timeout` caps the wait so a device
 * that never gets a fix doesn't hang the chip.
 */
function getBrowserCoords(): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        // "Null Island" guard: a fix at (0,0) is a no-data sentinel from
        // the OS location service, not a real position — reverse-geocoding
        // it labels the rail "Atlantic Ocean" (seen in the wild: Chrome
        // returns it before macOS Location Services has a fix, and the
        // 30-min cache then pins the bogus snapshot). Treat it as "no
        // fix" so the caller falls back to IP geolocation instead.
        if (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1) {
          resolve(null);
          return;
        }
        resolve({ lat, lon });
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

/**
 * Coordinates → city name via BigDataCloud's free client endpoint (no
 * key, CORS-open). Returns `null` on any failure so the caller can decide
 * whether to keep the coords with a different label or fall back to IP.
 */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("localityLanguage", "en");
    const res = await fetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as BigDataCloudReverse;
    for (const candidate of [data.city, data.locality, data.principalSubdivision]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** IP-based location via geojs. Coarse fallback — see file header. */
async function ipLocation(): Promise<ResolvedLocation> {
  const locRes = await fetch("https://get.geojs.io/v1/ip/geo.json", {
    signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS),
  });
  if (!locRes.ok) {
    throw new Error(`geojs: ${locRes.status}`);
  }
  const loc = (await locRes.json()) as GeoJsLocation;
  const lat = parseCoord(loc.latitude);
  const lon = parseCoord(loc.longitude);
  const city =
    typeof loc.city === "string" && loc.city.length > 0
      ? loc.city
      : typeof loc.region === "string" && loc.region.length > 0
        ? loc.region
        : null;
  if (lat === null || lon === null || city === null) {
    throw new Error("geojs: incomplete location");
  }
  return { lat, lon, city };
}

/**
 * Resolve the user's location, preferring the browser's real position.
 *
 * When geolocation is granted we keep its coordinates even if the
 * reverse-geocode lookup fails — accurate weather with a coordinate label
 * still beats a wrong city. We only fall back to IP when the device gives
 * us no fix at all.
 */
async function resolveLocation(): Promise<ResolvedLocation> {
  const coords = await getBrowserCoords();
  if (coords) {
    const city = await reverseGeocode(coords.lat, coords.lon);
    return {
      lat: coords.lat,
      lon: coords.lon,
      city: city ?? `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
    };
  }
  return ipLocation();
}

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const { lat, lon, city } = await resolveLocation();

  const unit = preferredTemperatureUnit();
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");
  if (unit === "F") url.searchParams.set("temperature_unit", "fahrenheit");
  const wRes = await fetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });
  if (!wRes.ok) {
    throw new Error(`open-meteo: ${wRes.status}`);
  }
  const w = (await wRes.json()) as OpenMeteoResponse;
  const tempRaw = w.current?.temperature_2m;
  if (typeof tempRaw !== "number") {
    throw new Error("open-meteo: missing temperature");
  }
  const code = typeof w.current?.weather_code === "number" ? w.current.weather_code : undefined;
  const isDayRaw = w.current?.is_day;
  const isDay = isDayRaw === 1 || isDayRaw === true || isDayRaw === undefined;

  return {
    temperature: Math.round(tempRaw),
    unit,
    city,
    condition: mapWeatherCode(code),
    isDay,
  };
}

/**
 * WMO weather codes (open-meteo's `weather_code`):
 *   0       = clear
 *   1-2     = mainly clear / partly cloudy → `partly_cloudy`
 *   3       = overcast → `cloudy`
 *   45-48   = fog
 *   51-67   = drizzle / rain
 *   71-77   = snow
 *   80-86   = rain showers / snow showers
 *   95-99   = thunderstorm
 *
 * 1-2 are split from 3 so the rail can pick the partly-cloudy loop
 * (lively, sunlit) for "mainly clear" weather and reserve the heavier
 * overcast loop for true overcast — matches dimension's split.
 */
function mapWeatherCode(code: number | undefined): WeatherCondition {
  if (code === undefined) return "unknown";
  if (code === 0) return "clear";
  if (code >= 1 && code <= 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code >= 45 && code <= 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "unknown";
}
