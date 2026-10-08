import { useWeather } from "~/hooks/use-weather";
import type { WeatherCondition } from "~/lib/weather";

/**
 * Rail weather hero: temperature and a "condition · city" caption. No icon; the video shows the weather.
 * `mix-blend-plus-lighter` makes the text glow into the video.
 * A cold load reserves the height; an error hides the block.
 */
export function WeatherHero() {
  const { data, isError } = useWeather();

  if (isError) {
    return null;
  }

  // Reserve the height so the content below does not jump.
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

const LABEL_FOR_CONDITION = {
  clear: "Sunny",
  partly_cloudy: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Foggy",
  rain: "Rainy",
  snow: "Snowy",
  storm: "Thunderstorm",
  unknown: null,
} satisfies Record<WeatherCondition, string | null>;
