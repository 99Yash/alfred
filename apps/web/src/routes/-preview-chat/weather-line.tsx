import { Cloud, CloudFog, CloudRain, CloudSnow, Sun, Zap, type LucideIcon } from "lucide-react";
import { useWeather } from "~/hooks/use-weather";
import type { WeatherCondition } from "~/lib/weather";
import { cn } from "~/lib/utils";

/**
 * Weather meta-line for the rail header. It lives on its own full-width
 * row beneath the greeting, so a long name, a long city, and a long
 * condition word can never collide in one flex row the way the old
 * top-right chip did.
 *
 * The icon + temperature sit in a fixed (`shrink-0`) lockup; the
 * "city · condition" text takes whatever width is left and truncates with
 * an ellipsis (with a `title` tooltip for the full string). No fixed
 * max-width, no width-morphing — the row is stable regardless of the
 * strings it's handed.
 *
 * Data comes from `useWeather()` (open-meteo + ip-based geolocation). The
 * line hides itself entirely while loading or on error — the rail's video
 * already says "weather here", so an empty row beats a churning skeleton.
 */
export function WeatherLine() {
  const { data, isLoading, isError } = useWeather();
  if (isLoading || isError || !data) {
    return null;
  }

  const Icon = ICON_FOR_CONDITION[data.condition];
  const conditionLabel = LABEL_FOR_CONDITION[data.condition];
  const place = conditionLabel ? `${data.city} · ${conditionLabel}` : data.city;

  return (
    <div
      className="mt-2 flex items-center gap-2 text-[12px] leading-none"
      aria-label={`${data.temperature} degrees ${data.unit} in ${data.city}, ${conditionLabel ?? data.condition}`}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <Icon
          size={13}
          className={cn("shrink-0", TONE_FOR_CONDITION[data.condition])}
          aria-hidden
        />
        <span className="font-medium text-white tabular-nums">
          {data.temperature}°{data.unit}
        </span>
      </span>
      <span className="min-w-0 truncate text-white/65" title={place}>
        {place}
      </span>
    </div>
  );
}

const ICON_FOR_CONDITION: Record<WeatherCondition, LucideIcon> = {
  clear: Sun,
  partly_cloudy: Cloud,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: Zap,
  unknown: Sun,
};

const TONE_FOR_CONDITION: Record<WeatherCondition, string> = {
  clear: "text-vs-amber-4",
  partly_cloudy: "text-vs-fg-3",
  cloudy: "text-vs-fg-3",
  fog: "text-vs-fg-3",
  rain: "text-vs-sky-4",
  snow: "text-vs-sky-4",
  storm: "text-vs-purple-4",
  unknown: "text-vs-fg-3",
};

const LABEL_FOR_CONDITION: Record<WeatherCondition, string | null> = {
  clear: "Sunny",
  partly_cloudy: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Foggy",
  rain: "Rainy",
  snow: "Snowy",
  storm: "Thunderstorm",
  unknown: null,
};
