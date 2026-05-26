import { Cloud, CloudFog, CloudRain, CloudSnow, Sun, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useWeather } from "~/hooks/use-weather";
import type { WeatherCondition } from "~/lib/weather";
import { cn } from "~/lib/utils";

/**
 * Compact weather widget. Dimension placed `Bhubaneswar 29°` in the rail's
 * top-right; we mirror that with a subtle surface plate sitting on top of
 * the atmosphere glow. Data comes from `useWeather()` (open-meteo +
 * ip-based geolocation) — the chip hides itself while loading or on
 * error so the rail header doesn't go visibly broken.
 *
 * The right slot is a 2-row slot-machine that alternates between the
 * city name and the human-readable condition every `ROLL_INTERVAL_MS`.
 * No keyframes — the inner column just translates by 100% on phase flip,
 * and the `motion-reduce` modifier kills the transition for users who
 * have asked for less motion.
 */
const ROLL_INTERVAL_MS = 3500;

export function WeatherChip() {
  const { data, isLoading, isError } = useWeather();
  const conditionLabel = data ? LABEL_FOR_CONDITION[data.condition] : null;
  const shouldRoll = conditionLabel !== null;
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!shouldRoll) return;
    const id = window.setInterval(
      () => setPhase((p) => (p === 0 ? 1 : 0)),
      ROLL_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [shouldRoll]);

  // Render nothing until real data lands. The previous pulsing
  // skeleton churned the header during the (sometimes long) retry
  // window when geojs / open-meteo were failing — the rail's video
  // already conveys "weather here", so silence > theater while we wait.
  if (isLoading || isError || !data) {
    return null;
  }

  const Icon = ICON_FOR_CONDITION[data.condition];
  return (
    <Plate aria-label={`${data.temperature} degrees ${data.unit} in ${data.city}, ${conditionLabel ?? data.condition}`}>
      <Icon size={12} className={cn("shrink-0", TONE_FOR_CONDITION[data.condition])} aria-hidden />
      <span className="text-[12px] font-medium text-vs-fg-4 tabular-nums">
        {data.temperature}°{data.unit}
      </span>
      <span aria-hidden className="h-3 w-px bg-vs-bg-3/80" />
      <TextRoller
        items={conditionLabel ? [data.city, conditionLabel] : [data.city]}
        phase={phase}
      />
    </Plate>
  );
}

function TextRoller({ items, phase }: { items: string[]; phase: number }) {
  const active = items.length > 1 ? phase % items.length : 0;
  return (
    <span
      aria-hidden
      className="relative inline-block h-[14px] max-w-[12ch] overflow-hidden align-middle"
    >
      <span
        className={cn(
          "flex flex-col will-change-transform",
          "transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
          "motion-reduce:transition-none",
        )}
        style={{ transform: `translateY(-${active * 14}px)` }}
      >
        {items.map((text, i) => (
          <span
            key={`${i}-${text}`}
            className="block h-[14px] leading-[14px] text-[11px] text-vs-fg-2 truncate"
          >
            {text}
          </span>
        ))}
      </span>
    </span>
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
