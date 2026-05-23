/**
 * Browser-side weather lookup.
 *
 * Two-step fetch:
 *   1. `ipapi.co/json` — IP-based location (no permission prompt, no auth).
 *      Returns city + lat/lon. Free tier is rate-limited per IP per day,
 *      which is fine for a single-user app pulling this once per session.
 *   2. `api.open-meteo.com` — current temperature + WMO weather code for
 *      the resolved coordinates. Also no auth, supports CORS.
 *
 * Both endpoints are CORS-enabled from the browser, so we don't proxy
 * through the API server. If either call fails (network, rate-limit) the
 * caller (react-query) surfaces it; the WeatherChip hides itself.
 */

export type WeatherCondition =
  | "clear"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "storm"
  | "unknown";

export interface WeatherSnapshot {
  /** Whole-degree Celsius. */
  temperatureC: number;
  /** City name (or region, when ipapi can't resolve a city). */
  city: string;
  condition: WeatherCondition;
}

interface IpLocation {
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

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const locRes = await fetch("https://ipapi.co/json/");
  if (!locRes.ok) {
    throw new Error(`ipapi: ${locRes.status}`);
  }
  const loc = (await locRes.json()) as IpLocation;
  const lat = typeof loc.latitude === "number" ? loc.latitude : null;
  const lon = typeof loc.longitude === "number" ? loc.longitude : null;
  const city =
    typeof loc.city === "string" && loc.city.length > 0
      ? loc.city
      : typeof loc.region === "string" && loc.region.length > 0
        ? loc.region
        : null;
  if (lat === null || lon === null || city === null) {
    throw new Error("ipapi: incomplete location");
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code");
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
    temperatureC: Math.round(tempRaw),
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
