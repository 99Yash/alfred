import { cn } from "~/lib/utils";

const WEATHER_VIDEO_SRC = "/videos/partly_cloudy.mp4";

export function WeatherVideoSurface({ className }: { className?: string }) {
  return (
    <span className={cn("absolute inset-0 overflow-hidden", className)} aria-hidden>
      <span className="dimension-weather-surface absolute inset-0" />
      <video
        autoPlay
        className="absolute inset-0 h-full w-full object-cover opacity-100 transition-opacity duration-1000"
        loop
        muted
        playsInline
        preload="metadata"
      >
        <source src={WEATHER_VIDEO_SRC} type="video/mp4" />
      </video>
    </span>
  );
}
