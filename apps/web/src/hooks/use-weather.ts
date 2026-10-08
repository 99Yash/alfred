import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";
import { fetchWeather, type WeatherSnapshot } from "~/lib/weather";

/** Cache TTL; also the query's stale time. */
const WEATHER_TTL_MS = 30 * 60 * 1000;

const CACHE_KEY = "alfred.weather.cache";

/** The cached snapshot if still within the TTL, else `null`. */
function readCache(): { data: WeatherSnapshot; fetchedAt: number } | null {
  const cached = getLocalStorageItem(CACHE_KEY);

  if (!cached.data || Date.now() - cached.fetchedAt > WEATHER_TTL_MS) return null;

  return { data: cached.data, fetchedAt: cached.fetchedAt };
}

function writeCache(data: WeatherSnapshot): void {
  setLocalStorageItem(CACHE_KEY, { data, fetchedAt: Date.now() });
}

/**
 * Weather query seeded from a localStorage cache, so the rail has data on the
 * first paint after a reload and skips the network until the TTL lapses.
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
    // Seed only on a hit: an explicit `undefined` is rejected under
    // exactOptionalPropertyTypes and breaks the `initialData` overload's typing.
    ...(cached ? { initialData: cached.data, initialDataUpdatedAt: cached.fetchedAt } : {}),
  });
}
