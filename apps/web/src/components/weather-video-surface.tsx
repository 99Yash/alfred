import { useEffect, useRef, useState } from "react";
import type { WeatherCondition } from "~/lib/weather";
import { cn } from "~/lib/utils";

/** Video behind the rail per condition. Night always plays the night loop. The CSS gradient under it covers a failed load. */
const VIDEO_FOR_CONDITION = {
  clear: "/videos/sunny.mp4",
  partly_cloudy: "/videos/partly_cloudy.mp4",
  cloudy: "/videos/cloudy.mp4",
  fog: "/videos/cloudy.mp4",
  rain: "/videos/rainy.mp4",
  snow: "/videos/cloudy.mp4",
  storm: "/videos/thunderstorm.mp4",
  unknown: "/videos/partly_cloudy.mp4",
} satisfies Record<WeatherCondition, string>;

const NIGHT_VIDEO = "/videos/night.mp4";

const DEFAULT_VIDEO = "/videos/partly_cloudy.mp4";

/**
 * Clock guess for when `useWeather()` has no data (open-meteo and geojs fail silently).
 * The window is wide on purpose: night video at 6pm reads better than a day sky.
 */
function isLocalNight(): boolean {
  if (typeof window === "undefined") return false;
  const hour = new Date().getHours();

  return hour < 6 || hour >= 18;
}

interface WeatherVideoSurfaceProps {
  /** Live condition; `undefined` while loading or after an error, which uses the clock guess. */
  condition?: WeatherCondition | undefined;
  isDay?: boolean | undefined;
  className?: string | undefined;
}

interface Layer {
  id: number;
  src: string;
}

export function WeatherVideoSurface({ condition, isDay, className }: WeatherVideoSurfaceProps) {
  const hasData = condition !== undefined;
  const isNightFallback = !hasData && isLocalNight();

  const videoSrc = !hasData
    ? isNightFallback
      ? NIGHT_VIDEO
      : DEFAULT_VIDEO
    : isDay === false
      ? NIGHT_VIDEO
      : VIDEO_FOR_CONDITION[condition];

  // Crossfade: push the new layer on top, fade it in, then prune the covered ones.
  // The covered layer stays visible, so the gradient never flashes. Last entry is active.
  const nextId = useRef(1);
  // Bump `nextId` here, not in the state updater: React can replay an updater, which would burn two ids.
  const lastSrcRef = useRef(videoSrc);
  const [layers, setLayers] = useState<Layer[]>(() => [{ id: 0, src: videoSrc }]);

  useEffect(() => {
    if (lastSrcRef.current === videoSrc) return;
    lastSrcRef.current = videoSrc;
    const id = nextId.current;
    nextId.current += 1;
    setLayers((prev) => [...prev, { id, src: videoSrc }]);
  }, [videoSrc]);

  const pruneTo = (id: number) => {
    setLayers((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.id === id)));
  };

  return (
    <span className={cn("absolute inset-0 overflow-hidden", className)} aria-hidden>
      <span className="dimension-weather-surface absolute inset-0" />
      {layers.map((layer, i) => (
        <WeatherVideoLayer
          key={layer.id}
          src={layer.src}
          active={i === layers.length - 1}
          onArrived={() => pruneTo(layer.id)}
        />
      ))}
      {condition === "cloudy" || condition === "fog" ? (
        <span className="pointer-events-none absolute inset-0 bg-black/25" />
      ) : null}
    </span>
  );
}

/** One crossfading layer at 0.5x speed. Under reduced motion it holds a still frame. */
function WeatherVideoLayer({
  src,
  active,
  onArrived,
}: {
  src: string;
  active: boolean;
  onArrived: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);

  // Show one frame after mount so the opacity transition runs.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));

    return () => cancelAnimationFrame(raf);
  }, []);

  // `playbackRate` is not a React prop. Re-check reduced motion if the user toggles it.
  useEffect(() => {
    const el = videoRef.current;

    if (!el) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");

    const apply = () => {
      el.playbackRate = 0.5;

      if (query.matches) {
        el.pause();
      } else {
        void el.play().catch(() => {});
      }
    };

    apply();
    query.addEventListener("change", apply);

    return () => query.removeEventListener("change", apply);
  }, [src]);

  return (
    <video
      ref={videoRef}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      preload="metadata"
      aria-label="Decorative weather background"
      tabIndex={-1}
      onTransitionEnd={() => {
        // The active layer prunes the ones beneath it once it has faded in.
        if (active && shown) onArrived();
      }}
      className={cn(
        "absolute inset-0 size-full object-cover",
        "pointer-events-none select-none",
        "transition-opacity duration-1000 ease-in-out",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}
