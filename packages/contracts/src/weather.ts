/**
 * Timezone to city map for briefing weather when the user has no stored
 * location (ADR-0041). Short on purpose: add zones as the user visits them.
 */

import type { IanaTimezone } from "./briefing";

/**
 * The administrative areas that hold a place, from the geocode. `countryCode` is ISO 3166-1
 * alpha-2. `region` is the first-level area (a state), and `district` the second-level area. A
 * national warning feed names its areas at these levels (ADR-0117 decision 4).
 */
export interface PlaceArea {
  countryCode: string;
  region?: string;
  district?: string;
}

/**
 * A place: its coordinates and the name to show. A time-zone default, a preference, and a
 * geocoded fact share this shape. A geocoded fact and a time-zone default have `area`; a
 * preference does not.
 */
export interface Place {
  lat: number;
  lng: number;
  label: string;
  area?: PlaceArea;
}

/**
 * A `Map`, not a `Record`: the table is not exhaustive, and `IanaTimezone` is branded. Each city
 * states its country, so the warnings gather knows which national feeds apply (ADR-0117 decision
 * 4). Delhi also states its LGD state and district, so the gather reads NDMA Sachet for it.
 */
export const WEATHER_FALLBACK_CITIES: ReadonlyMap<string, Place> = new Map<string, Place>([
  [
    "America/New_York",
    { lat: 40.7128, lng: -74.006, label: "New York", area: { countryCode: "US" } },
  ],
  [
    "America/Chicago",
    { lat: 41.8781, lng: -87.6298, label: "Chicago", area: { countryCode: "US" } },
  ],
  [
    "America/Denver",
    { lat: 39.7392, lng: -104.9903, label: "Denver", area: { countryCode: "US" } },
  ],
  [
    "America/Los_Angeles",
    { lat: 34.0522, lng: -118.2437, label: "Los Angeles", area: { countryCode: "US" } },
  ],
  [
    "America/Phoenix",
    { lat: 33.4484, lng: -112.074, label: "Phoenix", area: { countryCode: "US" } },
  ],
  [
    "America/Toronto",
    { lat: 43.6532, lng: -79.3832, label: "Toronto", area: { countryCode: "CA" } },
  ],
  [
    "America/Mexico_City",
    { lat: 19.4326, lng: -99.1332, label: "Mexico City", area: { countryCode: "MX" } },
  ],
  [
    "America/Sao_Paulo",
    { lat: -23.5505, lng: -46.6333, label: "São Paulo", area: { countryCode: "BR" } },
  ],
  ["Europe/London", { lat: 51.5074, lng: -0.1278, label: "London", area: { countryCode: "GB" } }],
  ["Europe/Paris", { lat: 48.8566, lng: 2.3522, label: "Paris", area: { countryCode: "FR" } }],
  ["Europe/Berlin", { lat: 52.52, lng: 13.405, label: "Berlin", area: { countryCode: "DE" } }],
  [
    "Europe/Amsterdam",
    { lat: 52.3676, lng: 4.9041, label: "Amsterdam", area: { countryCode: "NL" } },
  ],
  [
    "Asia/Kolkata",
    {
      lat: 28.6139,
      lng: 77.209,
      label: "Delhi",
      area: { countryCode: "IN", region: "Delhi", district: "New Delhi" },
    },
  ],
  ["Asia/Dubai", { lat: 25.2048, lng: 55.2708, label: "Dubai", area: { countryCode: "AE" } }],
  [
    "Asia/Singapore",
    { lat: 1.3521, lng: 103.8198, label: "Singapore", area: { countryCode: "SG" } },
  ],
  ["Asia/Tokyo", { lat: 35.6762, lng: 139.6503, label: "Tokyo", area: { countryCode: "JP" } }],
  [
    "Asia/Shanghai",
    { lat: 31.2304, lng: 121.4737, label: "Shanghai", area: { countryCode: "CN" } },
  ],
  [
    "Australia/Sydney",
    { lat: -33.8688, lng: 151.2093, label: "Sydney", area: { countryCode: "AU" } },
  ],
  ["UTC", { lat: 51.4934, lng: 0.0098, label: "Greenwich", area: { countryCode: "GB" } }],
]);

/**
 * ICU's id for a zone. An alias and its current name resolve to the same id, so a stored
 * `Asia/Calcutta` finds the `Asia/Kolkata` row. Which of the two ICU returns does not matter,
 * because the table keys go through the same function.
 */
function icuZoneId(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

const WEATHER_FALLBACK_BY_ICU_ID: ReadonlyMap<string, Place> = new Map(
  [...WEATHER_FALLBACK_CITIES].map(([tz, location]) => [icuZoneId(tz), location]),
);

/** `null` for an unknown zone. The caller decides what to do without weather. */
export function weatherFallbackFor(tz: IanaTimezone): Place | null {
  return WEATHER_FALLBACK_BY_ICU_ID.get(icuZoneId(tz)) ?? null;
}
