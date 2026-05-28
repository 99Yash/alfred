import { useEffect, useRef } from "react";
import type { WeatherCondition } from "~/lib/weather";
import { cn } from "~/lib/utils";

/**
 * Maps a (condition, isDay) pair to the public video asset that should
 * play behind the rail. The CSS `.dimension-weather-surface` layer below
 * the video acts as the always-on fallback — if any of these `src`s 404
 * (the repo only ships a README under `public/videos/` until the assets
 * are sourced), the user still sees the gradient sky instead of a black
 * box.
 *
 * Night wins over condition: at night we always play the night loop,
 * matching dimension's `weatherCondition === "night"` branch.
 */
const VIDEO_FOR_CONDITION: Record<WeatherCondition, string> = {
  clear: "/videos/sunny.mp4",
  partly_cloudy: "/videos/partly_cloudy.mp4",
  cloudy: "/videos/cloudy.mp4",
  fog: "/videos/cloudy.mp4",
  rain: "/videos/rainy.mp4",
  snow: "/videos/cloudy.mp4",
  storm: "/videos/thunderstorm.mp4",
  unknown: "/videos/partly_cloudy.mp4",
};

const NIGHT_VIDEO = "/videos/night.mp4";
const DEFAULT_VIDEO = "/videos/partly_cloudy.mp4";

/**
 * Local-clock fallback used when `useWeather()` hasn't resolved yet or
 * has errored (open-meteo / geojs occasionally fail from the browser
 * with no CORS surface). Mirrors the open-meteo `is_day` branch we'd
 * normally take, just without sunrise/sunset precision.
 *
 * The window is intentionally wide — civil-evening starts long before
 * astronomical sunset, and "show night.mp4 at 6pm in Bhubaneswar" reads
 * far less weird than "show partly_cloudy at 6pm".
 */
function isLocalNight(): boolean {
  if (typeof window === "undefined") return false;
  const hour = new Date().getHours();
  return hour < 6 || hour >= 18;
}

interface WeatherVideoSurfaceProps {
  /**
   * Live weather condition from `useWeather()`. `undefined` while the
   * query is loading or errored — the component falls back to a local-
   * clock pick (night.mp4 vs partly_cloudy.mp4) and plays it at full
   * opacity. We prefer "wrong-but-plausible loop" over an empty rail
   * here because geojs/open-meteo failure is silent and indefinite.
   */
  condition?: WeatherCondition;
  /** Daytime flag from open-meteo. `false` swaps in the night loop. */
  isDay?: boolean;
  className?: string;
}

export function WeatherVideoSurface({ condition, isDay, className }: WeatherVideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasData = condition !== undefined;
  // Without a weather signal, fall back to local-clock night/day so the
  // rail at least matches the user's wall-time. Skipping this fallback
  // is how we ended up showing partly-cloudy at 7pm in Bhubaneswar.
  const isNightFallback = !hasData && isLocalNight();
  const videoSrc = !hasData
    ? isNightFallback
      ? NIGHT_VIDEO
      : DEFAULT_VIDEO
    : isDay === false
      ? NIGHT_VIDEO
      : VIDEO_FOR_CONDITION[condition];

  // Slow the loop to 0.5× — atmospheric, less distracting. Matches
  // dimension. Applied imperatively because `playbackRate` isn't a
  // React prop on `<video>`; re-applied whenever the src swaps so the
  // new clip also plays at half speed.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.playbackRate = 0.5;
  }, [videoSrc]);

  return (
    <span className={cn("absolute inset-0 overflow-hidden", className)} aria-hidden>
      <span className="dimension-weather-surface absolute inset-0" />
      <video
        ref={videoRef}
        key={videoSrc}
        autoPlay
        loop
        muted
        playsInline
        disablePictureInPicture
        preload="metadata"
        aria-label="Decorative weather background"
        tabIndex={-1}
        className={cn(
          "absolute inset-0 h-full w-full object-cover",
          "pointer-events-none select-none",
          "transition-opacity duration-1000 ease-in-out",
          // Always render the chosen video: the fallback (local-clock
          // night vs partly_cloudy) is meaningful on its own, so the
          // rail doesn't sit empty waiting for the weather hook —
          // especially on geojs/open-meteo failure paths.
          "opacity-100",
        )}
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
      {condition === "cloudy" || condition === "fog" ? (
        <span className="pointer-events-none absolute inset-0 bg-black/25" />
      ) : null}
    </span>
  );
}
