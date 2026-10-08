import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The one full-bleed band on the landing, so the page is not one thin centered column.
 * The `notch` hangs from the top edge on the page side, so the tab control sits
 * outside the content it controls.
 */
export function HeroBand({
  children,
  notch,
  className,
}: {
  children: ReactNode;
  notch?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("relative isolate w-full overflow-hidden", className)}>
      <BandAtmosphere />

      {/* Hairlines at both edges. The top one is brighter, as light catches the near lip. */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-white/[0.09]" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-white/[0.05]" />

      {notch ? (
        <div
          className={cn(
            "absolute top-0 left-1/2 z-20 -translate-x-1/2",
            "flex h-[52px] items-center rounded-b-[26px] bg-[#0a0a0a] px-3 sm:px-5",
            // Fixed labels: on a narrow screen the row scrolls instead of wrapping in the rounded notch.
            "max-w-[calc(100vw-1.5rem)] [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden",
          )}
        >
          {notch}
        </div>
      ) : null}

      <div
        className={cn(
          "relative z-10 mx-auto w-full max-w-5xl px-5 sm:px-6",
          // Top padding clears the notch; less at the bottom so the panel sits low.
          notch ? "pt-24 pb-14 sm:pt-28 sm:pb-20" : "py-14 sm:py-20",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Static band sky: indigo wash, two blooms, cloud texture, bottom fade to black.
 * No animation: slow motion across 100vw causes motion sickness.
 */
function BandAtmosphere() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[#0d0b1a]" />

      <div
        className="absolute inset-0"
        style={{
          background: [
            "radial-gradient(120% 90% at 50% 0%, rgba(79, 70, 229, 0.42) 0%, rgba(67, 56, 202, 0.14) 42%, transparent 72%)",
            "radial-gradient(55% 55% at 50% 8%, rgba(167, 139, 250, 0.34) 0%, transparent 68%)",
            "radial-gradient(90% 70% at 12% 100%, rgba(139, 92, 246, 0.14) 0%, transparent 65%)",
          ].join(", "),
        }}
      />

      {/* Shared cloud texture. `overlay` changes value, not hue. */}
      <img
        src="/images/landing/shadow-bg.png"
        alt=""
        className="absolute inset-0 size-full object-cover opacity-[0.28] mix-blend-overlay select-none"
      />

      {/* Fade at the bottom only. A top scrim darkens where the light comes from. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-b from-transparent to-[#0a0a0a]" />
    </div>
  );
}
