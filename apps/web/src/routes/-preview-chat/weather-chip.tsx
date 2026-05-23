import { Cloud, CloudFog, CloudRain, CloudSnow, Sun, Zap, type LucideIcon } from "lucide-react";
import { useWeather } from "~/hooks/use-weather";
import type { WeatherCondition } from "~/lib/weather";
import { cn } from "~/lib/utils";

/**
 * Compact weather widget. Dimension placed `Bhubaneswar 29°` in the rail's
 * top-right; we mirror that with a subtle surface plate sitting on top of
 * the atmosphere glow. Data comes from `useWeather()` (open-meteo +
 * ip-based geolocation) — the chip hides itself while loading or on
 * error so the rail header doesn't go visibly broken.
 */
export function WeatherChip() {
  const { data, isLoading, isError } = useWeather();

  if (isLoading) {
    return <Plate aria-label="Weather loading" className="animate-pulse w-[88px]" />;
  }
  if (isError || !data) {
    return null;
  }

  const Icon = ICON_FOR_CONDITION[data.condition];
  return (
    <Plate aria-label={`${data.temperatureC} degrees in ${data.city}`}>
      <Icon size={12} className={cn("shrink-0", TONE_FOR_CONDITION[data.condition])} aria-hidden />
      <span className="text-[12px] font-medium text-vs-fg-4 tabular-nums">
        {data.temperatureC}°
      </span>
      <span aria-hidden className="h-3 w-px bg-vs-bg-3/80" />
      <span className="text-[11px] text-vs-fg-2 truncate max-w-[10ch]">{data.city}</span>
    </Plate>
  );
}

function Plate({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full h-7 pl-2 pr-2.5",
        "bg-vs-bg-1/70 ring-1 ring-vs-bg-3/70 backdrop-blur",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

const ICON_FOR_CONDITION: Record<WeatherCondition, LucideIcon> = {
  clear: Sun,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: Zap,
  unknown: Sun,
};

const TONE_FOR_CONDITION: Record<WeatherCondition, string> = {
  clear: "text-vs-amber-4",
  cloudy: "text-vs-fg-3",
  fog: "text-vs-fg-3",
  rain: "text-vs-sky-4",
  snow: "text-vs-sky-4",
  storm: "text-vs-purple-4",
  unknown: "text-vs-fg-3",
};
