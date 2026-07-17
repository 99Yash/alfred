import { useWeather } from "~/hooks/use-weather";
import type { WeatherCondition } from "~/lib/weather";

/**
 * Weather hero for the rail header — the focal block of the "Today" panel.
 *
 * Deliberately icon-less. The condition is carried entirely by the
 * full-bleed condition-aware video behind the rail (sun, storm, rain…),
 * the same way dimension.dev's rail does it — a small glyph next to the
 * number reads as toy-like against a cinematic sky, and the moving video
 * already *is* the weather icon. So the block is pure typography: a large
 * temperature, then a quiet "condition · city" caption.
 *
 * The text uses `mix-blend-plus-lighter` so it adds its luminance into the
 * video rather than sitting flatly on top — over the dark header scrim it
 * reads as a soft glow, which is the "weather-surface" feel. (The original
 * rail header blended this way; the hero keeps it.)
 *
 * Data comes from `useWeather()` (open-meteo + ip/browser geolocation),
 * seeded from a localStorage cache so a reload usually paints immediately.
 * While a cold load is in flight we reserve the block's height so the date
 * and feed below don't jump when data lands. A hard error collapses the
 * block — the video already reads as "weather here".
 */
export function WeatherHero() {
  const { data, isError } = useWeather();
  if (isError) {
    return null;
  }
  // Reserve the hero's height on a cold load so nothing below jumps when
  // the temperature lands (number row + caption).
  if (!data) {
    return <div className="mt-3 h-[52px]" aria-hidden />;
  }

  const conditionLabel = LABEL_FOR_CONDITION[data.condition];
  const caption = conditionLabel ? `${conditionLabel} · ${data.city}` : data.city;

  return (
    <div
      className="animate-rail-head mt-3 [animation-delay:60ms]"
      aria-label={`${data.temperature} degrees ${data.unit} in ${data.city}, ${conditionLabel ?? data.condition}`}
    >
      <div className="text-[2.125rem] leading-none font-normal tracking-tight text-white tabular-nums mix-blend-plus-lighter">
        {data.temperature}°
      </div>
      <div
        className="animate-rail-head mt-2.5 min-w-0 truncate text-[0.78rem] leading-none font-medium text-white/70 mix-blend-plus-lighter [animation-delay:150ms]"
        title={caption}
      >
        {caption}
      </div>
    </div>
  );
}

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
