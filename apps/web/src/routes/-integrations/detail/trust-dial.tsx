import { cn } from "~/lib/utils";

/** 36 ticks, one every 10 degrees; every ninth one is a longer major tick. The angle is the key. */
const DIAL_TICKS = Array.from({ length: 36 }, (_, i) => {
  const angle = (i / 36) * Math.PI * 2;
  const major = i % 9 === 0;
  const inner = 30;
  const outer = major ? 40 : 36;

  return {
    degrees: i * 10,
    major,
    x1: 48 + Math.cos(angle) * inner,
    y1: 48 + Math.sin(angle) * inner,
    x2: 48 + Math.cos(angle) * outer,
    y2: 48 + Math.sin(angle) * outer,
  };
});

export function TrustDial() {
  return (
    <svg
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 -right-3 size-28 -translate-y-1/2",
        "text-app-purple-3 opacity-90",
      )}
      viewBox="0 0 96 96"
      fill="none"
    >
      <defs>
        <radialGradient id="vsTrustDialGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="46" fill="url(#vsTrustDialGlow)" />
      {DIAL_TICKS.map((tick) => (
        <line
          key={tick.degrees}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
          stroke="currentColor"
          strokeOpacity={tick.major ? 0.55 : 0.35}
          strokeWidth={tick.major ? 1.5 : 0.8}
          strokeLinecap="round"
        />
      ))}
      <circle cx="48" cy="48" r="24" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" />
      <circle cx="48" cy="48" r="14" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1" />
      <circle cx="48" cy="48" r="3" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}
