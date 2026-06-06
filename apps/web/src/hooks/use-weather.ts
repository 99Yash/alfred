import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage";
import { fetchWeather, type WeatherSnapshot } from "~/lib/weather";

/** Cache window — survives reloads and gates refetches. */
const WEATHER_TTL_MS = 30 * 60 * 1000;
const CACHE_KEY = "alfred.weather.cache";

/**
 * Read the last snapshot if it's still within the TTL. Returns `null` on a
 * miss (empty cache reads as `fetchedAt: 0`, i.e. always stale) — the caller
 * falls through to a fresh fetch. Validation/SSR/private-mode are handled by
 * the storage layer.
 */
function readCache(): { data: WeatherSnapshot; fetchedAt: number } | null {
  const cached = getLocalStorageItem(CACHE_KEY);
  if (!cached.data || Date.now() - cached.fetchedAt > WEATHER_TTL_MS) return null;
  return { data: cached.data, fetchedAt: cached.fetchedAt };
}

function writeCache(data: WeatherSnapshot): void {
  setLocalStorageItem(CACHE_KEY, { data, fetchedAt: Date.now() });
}

/**
 * React Query wrapper around `fetchWeather`, backed by a localStorage
 * cache so the rail has data on the first paint after a reload — no
 * loading flash, no layout shift, no redundant geolocation/API hit.
 *
 * The persisted snapshot seeds React Query's `initialData`; because its
 * timestamp is within `staleTime`, the query is considered fresh and
 * skips the network entirely until the TTL lapses. We don't retry
 * aggressively — the weather line reserves its row while loading and
 * hides only on a hard error.
 */
export function useWeather() {
  const [cached] = useState(() => readCache());
  return useQuery<WeatherSnapshot>({
    queryKey: ["weather"],
    queryFn: async () => {
      const data = await fetchWeather();
      writeCache(data);
      return data;
    },
    staleTime: WEATHER_TTL_MS,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.fetchedAt,
  });
}
