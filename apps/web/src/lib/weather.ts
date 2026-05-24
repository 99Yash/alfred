/**
 * Browser-side weather lookup.
 *
 * Two-step fetch:
 *   1. `get.geojs.io/v1/ip/geo.json` — IP-based location (no permission
 *      prompt, no auth). Sends `Access-Control-Allow-Origin: *`, so it
 *      works from `http://localhost` and any deployed origin. Returns
 *      `latitude`/`longitude` as **strings**, so we parse them.
 *   2. `api.open-meteo.com` — current temperature + WMO weather code for
 *      the resolved coordinates. Also no auth, CORS-open.
 *
 * If either call fails (network, rate-limit) the caller (react-query)
 * surfaces it; the WeatherChip hides itself.
 *
 * History: we used `ipapi.co` originally — they now serve 429s without
 * CORS headers on the free tier, which the browser reports as a CORS
 * error. Don't reintroduce it without proxying through our API.
 */

export type WeatherCondition =
  | "clear"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "storm"
  | "unknown";

export type TemperatureUnit = "C" | "F";

export interface WeatherSnapshot {
  /** Whole-degree temperature in `unit`. */
  temperature: number;
  unit: TemperatureUnit;
  /** City name (or region, when geojs can't resolve a city). */
  city: string;
  condition: WeatherCondition;
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

const FAHRENHEIT_REGIONS = new Set(["US", "BS", "BZ", "KY", "PW", "FM", "MH", "LR"]);

interface GeoJsLocation {
  city?: unknown;
  region?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: unknown;
    weather_code?: unknown;
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

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const locRes = await fetch("https://get.geojs.io/v1/ip/geo.json");
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

  const unit = preferredTemperatureUnit();
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code");
  if (unit === "F") url.searchParams.set("temperature_unit", "fahrenheit");
  const wRes = await fetch(url);
  if (!wRes.ok) {
    throw new Error(`open-meteo: ${wRes.status}`);
  }
  const w = (await wRes.json()) as OpenMeteoResponse;
  const tempRaw = w.current?.temperature_2m;
  if (typeof tempRaw !== "number") {
    throw new Error("open-meteo: missing temperature");
  }
  const code = typeof w.current?.weather_code === "number" ? w.current.weather_code : undefined;

  return {
    temperature: Math.round(tempRaw),
    unit,
    city,
    condition: mapWeatherCode(code),
  };
}

/**
 * WMO weather codes (open-meteo's `weather_code`):
 *   0       = clear
 *   1-3     = mainly clear / partly cloudy / overcast
 *   45-48   = fog
 *   51-67   = drizzle / rain
 *   71-77   = snow
 *   80-86   = rain showers / snow showers
 *   95-99   = thunderstorm
 */
function mapWeatherCode(code: number | undefined): WeatherCondition {
  if (code === undefined) return "unknown";
  if (code === 0) return "clear";
  if (code >= 1 && code <= 3) return "cloudy";
  if (code >= 45 && code <= 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "unknown";
}
