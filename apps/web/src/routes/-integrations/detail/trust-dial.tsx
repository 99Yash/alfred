import { cn } from "~/lib/utils";

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
      {Array.from({ length: 36 }).map((_, i) => {
        const angle = (i / 36) * Math.PI * 2;
        const inner = 30;
        const outer = i % 9 === 0 ? 40 : 36;
        const x1 = 48 + Math.cos(angle) * inner;
        const y1 = 48 + Math.sin(angle) * inner;
        const x2 = 48 + Math.cos(angle) * outer;
        const y2 = 48 + Math.sin(angle) * outer;
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeOpacity={i % 9 === 0 ? 0.55 : 0.35}
            strokeWidth={i % 9 === 0 ? 1.5 : 0.8}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="48" cy="48" r="24" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" />
      <circle cx="48" cy="48" r="14" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1" />
      <circle cx="48" cy="48" r="3" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}
