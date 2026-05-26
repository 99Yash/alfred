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

interface WeatherVideoSurfaceProps {
  /**
   * Live weather condition from `useWeather()`. `undefined` while the
   * query is loading or errored — the component falls back to the CSS
   * sky and keeps the video element at opacity-0 so we don't flash a
   * stale loop before data lands.
   */
  condition?: WeatherCondition;
  /** Daytime flag from open-meteo. `false` swaps in the night loop. */
  isDay?: boolean;
  className?: string;
}

export function WeatherVideoSurface({
  condition,
  isDay = true,
  className,
}: WeatherVideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasData = condition !== undefined;
  const videoSrc = !hasData
    ? DEFAULT_VIDEO
    : !isDay
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
        className={cn(
          "absolute inset-0 h-full w-full object-cover",
          "pointer-events-none select-none",
          "transition-opacity duration-1000 ease-in-out",
          hasData ? "opacity-100" : "opacity-0",
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
