/**
 * Hand-curated IANA-timezone → principal-city map for the briefing weather
 * contributor (ADR-0041 §"v1 source notes"). Used when the user has not set
 * a `user_preferences.location` row. Add zones as the user actually visits
 * them — kept short on purpose, the user's stored location is the right
 * source of truth once set.
 */

import type { IanaTimezone } from "./briefing.js";

export interface WeatherFallbackLocation {
  lat: number;
  lng: number;
  label: string;
}

/**
 * Hand-curated subset of IANA zones the briefing weather contributor knows.
 * A `Map` is the honest shape — `Record<IanaTimezone, ...>` would suggest
 * the table is exhaustive (it isn't), and `Partial<Record<IanaTimezone, ...>>`
 * can't accept plain string-literal keys because `IanaTimezone` is branded.
 * Callers must treat a miss as a miss (see `weatherFallbackFor`).
 */
export const WEATHER_FALLBACK_CITIES: ReadonlyMap<string, WeatherFallbackLocation> = new Map<
  string,
  WeatherFallbackLocation
>([
  ["America/New_York", { lat: 40.7128, lng: -74.006, label: "New York" }],
  ["America/Chicago", { lat: 41.8781, lng: -87.6298, label: "Chicago" }],
  ["America/Denver", { lat: 39.7392, lng: -104.9903, label: "Denver" }],
  ["America/Los_Angeles", { lat: 34.0522, lng: -118.2437, label: "Los Angeles" }],
  ["America/Phoenix", { lat: 33.4484, lng: -112.074, label: "Phoenix" }],
  ["America/Toronto", { lat: 43.6532, lng: -79.3832, label: "Toronto" }],
  ["America/Mexico_City", { lat: 19.4326, lng: -99.1332, label: "Mexico City" }],
  ["America/Sao_Paulo", { lat: -23.5505, lng: -46.6333, label: "São Paulo" }],
  ["Europe/London", { lat: 51.5074, lng: -0.1278, label: "London" }],
  ["Europe/Paris", { lat: 48.8566, lng: 2.3522, label: "Paris" }],
  ["Europe/Berlin", { lat: 52.52, lng: 13.405, label: "Berlin" }],
  ["Europe/Amsterdam", { lat: 52.3676, lng: 4.9041, label: "Amsterdam" }],
  ["Asia/Kolkata", { lat: 28.6139, lng: 77.209, label: "Delhi" }],
  ["Asia/Dubai", { lat: 25.2048, lng: 55.2708, label: "Dubai" }],
  ["Asia/Singapore", { lat: 1.3521, lng: 103.8198, label: "Singapore" }],
  ["Asia/Tokyo", { lat: 35.6762, lng: 139.6503, label: "Tokyo" }],
  ["Asia/Shanghai", { lat: 31.2304, lng: 121.4737, label: "Shanghai" }],
  ["Australia/Sydney", { lat: -33.8688, lng: 151.2093, label: "Sydney" }],
  ["UTC", { lat: 51.4934, lng: 0.0098, label: "Greenwich" }],
]);

/**
 * Lookup helper. Returns `null` when the timezone isn't in the curated
 * table — caller decides whether to omit weather from the briefing or use a
 * different fallback. Cheaper than throwing because the gather step
 * `Promise.allSettled`s its contributors.
 */
export function weatherFallbackFor(tz: IanaTimezone): WeatherFallbackLocation | null {
  return WEATHER_FALLBACK_CITIES.get(tz) ?? null;
}
