import { useQuery } from "@tanstack/react-query";
import { fetchWeather, type WeatherSnapshot } from "~/lib/weather";

/**
 * React Query wrapper around `fetchWeather`. Caches per browser tab for
 * the session; 30-minute stale window means the rail won't hammer the
 * APIs on every nav. We don't retry aggressively — the weather line hides
 * itself on failure rather than blocking the rail.
 */
export function useWeather() {
  return useQuery<WeatherSnapshot>({
    queryKey: ["weather"],
    queryFn: fetchWeather,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
