import { useEffect, useRef, useState } from "react";
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

interface Layer {
  id: number;
  src: string;
}

export function WeatherVideoSurface({ condition, isDay, className }: WeatherVideoSurfaceProps) {
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

  // Condition changes crossfade rather than hard-cut: a new layer is pushed
  // on top and fades in over 1s while the previous layer stays put beneath
  // it (so there is never a transparent dip that flashes the gradient), then
  // the now-covered layers are pruned once the new one has fully arrived
  // (apple-design §7 — materialize, don't jump-cut). The array's last entry
  // is always the active layer.
  const nextId = useRef(1);
  // Tracks the src of the current top layer so the append decision and the id
  // bump live in the effect body, not inside the state updater. React can run
  // an updater more than once (Strict Mode, bail-out replays); keeping the
  // `nextId` write out of it means one append never burns two ids.
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

/**
 * One crossfading video layer. Mounts transparent and fades to full opacity
 * on the next frame so the swap reads as a dissolve. Playback is slowed to
 * 0.5× (atmospheric, matches dimension) and paused entirely under
 * `prefers-reduced-motion` — a full-bleed looping video is exactly the
 * vestibular motion that setting asks us to stop (apple-design §14), so we
 * hold a still frame instead of hiding the sky.
 */
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

  // Flip to visible one frame after mount so the opacity transition runs
  // from 0 → 100 instead of painting at full opacity immediately.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // `playbackRate` isn't a React prop, so set it imperatively; honor
  // reduced-motion by pausing (holding a frame) and re-evaluate if the user
  // toggles the setting while the rail is open.
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
        // Once the active layer has fully faded in, drop the layers beneath
        // it. Faded-out (inactive) layers ignore this — the active one prunes
        // them.
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
