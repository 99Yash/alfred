import { Cloud, CloudFog, CloudRain, CloudSnow, Sun, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
 * Borrowing Apple's Dynamic Island feel, the slot doesn't reserve a
 * fixed max-width box (which left the shorter label stranded in dead
 * space); instead it *measures* each label and morphs its width in
 * lockstep with the vertical roll, so the whole pill breathes in and
 * out to hug whatever's on screen. No keyframes, no motion library —
 * the inner column translates by 100% while the outer slot animates
 * `width`, both on the same easing. `motion-reduce` kills both for
 * users who have asked for less motion.
 */
const ROLL_INTERVAL_MS = 3500;
const ROLL_EASE =
  "transition-[width,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export function WeatherChip() {
  const { data, isLoading, isError } = useWeather();
  const conditionLabel = data ? LABEL_FOR_CONDITION[data.condition] : null;

  const items = useMemo(() => {
    if (!data) return [] as string[];
    return conditionLabel ? [data.city, conditionLabel] : [data.city];
  }, [data, conditionLabel]);

  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (items.length < 2) {
      setPhase(0);
      return;
    }
    const id = window.setInterval(() => setPhase((p) => (p + 1) % items.length), ROLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [items.length]);

  // Render nothing until real data lands. The previous pulsing
  // skeleton churned the header during the (sometimes long) retry
  // window when geojs / open-meteo were failing — the rail's video
  // already conveys "weather here", so silence > theater while we wait.
  if (isLoading || isError || !data) {
    return null;
  }

  const Icon = ICON_FOR_CONDITION[data.condition];
  return (
    <Plate
      aria-label={`${data.temperature} degrees ${data.unit} in ${data.city}, ${conditionLabel ?? data.condition}`}
    >
      <Icon size={12} className={cn("shrink-0", TONE_FOR_CONDITION[data.condition])} aria-hidden />
      <span className="text-[12px] font-medium text-vs-fg-4 tabular-nums">
        {data.temperature}°{data.unit}
      </span>
      <span aria-hidden className="h-3 w-px bg-vs-fg-4/20" />
      <TextRoller items={items} active={phase % Math.max(items.length, 1)} />
    </Plate>
  );
}

function TextRoller({ items, active }: { items: string[]; active: number }) {
  const itemRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [widths, setWidths] = useState<number[]>([]);

  // Measure each label's intrinsic width so the slot can morph to hug
  // the active one. `useLayoutEffect` lands the measurement before
  // paint (no auto→fixed-width snap on mount), and `document.fonts`
  // re-measures once the webfont swaps in so we don't lock to fallback
  // metrics.
  const key = items.join("\0");
  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      setWidths(
        itemRefs.current.map((el) => (el ? Math.ceil(el.getBoundingClientRect().width) : 0)),
      );
    };
    measure();
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);

  const width = widths[active];
  return (
    <span
      aria-hidden
      className={cn("relative inline-block h-[14px] overflow-hidden align-middle", ROLL_EASE)}
      style={width ? { width } : undefined}
    >
      {/* Invisible measurers — laid out but never painted; give us each
          label's natural width without affecting the visible slot. */}
      <span className="invisible absolute left-0 top-0 flex flex-col items-start" aria-hidden>
        {items.map((text, i) => (
          <span
            key={`m-${i}-${text}`}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="block h-[14px] whitespace-nowrap text-[11px] leading-[14px]"
          >
            {text}
          </span>
        ))}
      </span>
      {/* Visible slot-machine column. */}
      <span
        className={cn("flex flex-col will-change-transform", ROLL_EASE)}
        style={{ transform: `translateY(-${active * 14}px)` }}
      >
        {items.map((text, i) => (
          <span
            key={`${i}-${text}`}
            className="block h-[14px] whitespace-nowrap text-[11px] leading-[14px] text-vs-fg-3"
          >
            {text}
          </span>
        ))}
      </span>
    </span>
  );
}

function Plate({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full h-7 pl-2 pr-2.5",
        "bg-vs-bg-1/80 ring-1 ring-vs-fg-4/10 backdrop-blur-md",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
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
