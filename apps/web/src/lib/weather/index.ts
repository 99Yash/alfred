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
 *
 * Provider payloads are untrusted: each response is parsed through the wire
 * schemas in `./schemas` at the owning fetch, never cast.
 */

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
  /** City name, region name, or a coordinate label — whatever the rail can display. */
  label: string;
}

/**
 * GET a JSON body from a provider with the shared timeout. Throws a labeled
 * error on non-2xx or malformed JSON; the caller decides whether that is a
 * hard failure or a reason to fall back.
 */
async function fetchJson(url: URL, source: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${source}: ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${source}: invalid JSON response`);
  }
}

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
      {
        enableHighAccuracy: false,
        timeout: GEOLOCATION_FIX_TIMEOUT_MS,
        maximumAge: 10 * 60 * 1000,
      },
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
    const data = await fetchJson(url, "bigdatacloud");
    const parsed = bigDataCloudReverseSchema.safeParse(data);
    if (!parsed.success) return null;
    const { city, locality, principalSubdivision } = parsed.data;
    return city ?? locality ?? principalSubdivision ?? null;
  } catch {
    return null;
  }
}

/** IP-based location via geojs. Coarse fallback — see file header. */
async function ipLocation(): Promise<ResolvedLocation> {
  const data = await fetchJson(new URL("https://get.geojs.io/v1/ip/geo.json"), "geojs");
  const parsed = geoJsLocationSchema.safeParse(data);
  if (!parsed.success) throw new Error("geojs: invalid response");
  const { latitude, longitude, city, region } = parsed.data;
  const label = city ?? region;
  if (latitude === undefined || longitude === undefined || label === undefined) {
    throw new Error("geojs: incomplete location");
  }
  return { lat: latitude, lon: longitude, label };
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

  const data = await fetchJson(url, "open-meteo");
  const parsed = openMeteoResponseSchema.safeParse(data);
  if (!parsed.success || !parsed.data.current) {
    throw new Error("open-meteo: invalid response");
  }
  return { ...parsed.data.current, unit, city: label };
}
