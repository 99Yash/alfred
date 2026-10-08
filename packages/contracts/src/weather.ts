/**
 * Timezone to city map for briefing weather when the user has no stored
 * location (ADR-0041). Short on purpose: add zones as the user visits them.
 */

import type { IanaTimezone } from "./briefing";

export interface WeatherFallbackLocation {
  lat: number;
  lng: number;
  label: string;
}

/** A `Map`, not a `Record`: the table is not exhaustive, and `IanaTimezone` is branded. */
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

/** `null` for an unknown zone. The caller decides what to do without weather. */
export function weatherFallbackFor(tz: IanaTimezone): WeatherFallbackLocation | null {
  return WEATHER_FALLBACK_CITIES.get(tz) ?? null;
}
