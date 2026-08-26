import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The full-bleed atmospheric band the hero product panel sits in.
 *
 * This is the page's one edge-to-edge moment, and it exists to break the
 * single centered column. Everything else on the landing lives inside
 * `max-w-5xl`; if the product shot does too, the whole page reads as one
 * thin strip down the middle of a wide black canvas. The band widens the
 * page exactly once, at the moment the reader first sees the product.
 *
 * Two parts, both lifted from visitors.now and re-registered for a dark
 * canvas:
 *
 *   • the band itself — a deep indigo aurora, edge to edge, with hairlines
 *     at both boundaries so it reads as a distinct material layer rather
 *     than a gradient that leaked. Theirs is a photographed dawn sky on
 *     white; ours is an indigo night, because Alfred's whole story is the
 *     assistant that works while you sleep.
 *
 *   • the notch — `notch` renders in a page-colored tab that hangs down from
 *     the band's top edge with rounded bottom corners. It is not decoration:
 *     it puts the tab control on the *page* side of the boundary while the
 *     thing it controls sits inside the band, so the spatial relationship
 *     between control and content is unmistakable. A control near what it
 *     affects needs no label explaining the connection.
 */
export function HeroBand({
  children,
  notch,
  className,
}: {
  children: ReactNode;
  /** Control row rendered in the page-colored notch on the band's top edge. */
  notch?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("relative isolate w-full overflow-hidden", className)}>
      <BandAtmosphere />

      {/* Hairlines mark where the material starts and stops. A bright top
       * edge is light catching the near lip of a translucent layer; the
       * bottom edge is dimmer because it faces away. */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-white/[0.09]" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-white/[0.05]" />

      {notch ? (
        <div
          className={cn(
            "absolute top-0 left-1/2 z-20 -translate-x-1/2",
            "flex h-[52px] items-center rounded-b-[26px] bg-[#0a0a0a] px-3 sm:px-5",
            // The notch can never exceed the viewport: the tab labels are
            // fixed strings, so at a narrow width the row scrolls rather than
            // wrapping inside a shape that is 26px-rounded at the bottom.
            "max-w-[calc(100vw-1.5rem)] [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden",
          )}
        >
          {notch}
        </div>
      ) : null}

      <div
        className={cn(
          "relative z-10 mx-auto w-full max-w-5xl px-5 sm:px-6",
          // Top padding clears the notch; the tighter bottom lets the panel
          // sit low in the band so the band frames it rather than floating it.
          notch ? "pt-24 pb-14 sm:pt-28 sm:pb-20" : "py-14 sm:py-20",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The band's sky. Four stacked layers, cheapest first:
 *
 *   1. a base indigo wash so the band always has body,
 *   2. two radial blooms (wide indigo, tighter violet) that put the light
 *      source behind and above the product panel,
 *   3. the shared cloud texture at `overlay`, which gives the gradient real
 *      depth instead of a flat mathematical ramp,
 *   4. a bottom fade back to page black so the band resolves into the page
 *      instead of ending on a hard line.
 *
 * All of it is static paint — no animation. A large, slowly oscillating
 * background is exactly the kind of motion that makes people motion-sick,
 * and this surface is 100vw.
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

      {/* Cloud texture — the same brand-neutral shadow map the onboarding sky
       * uses. `overlay` keeps the indigo hue and only modulates its value, so
       * the band gains cloud structure without shifting colour. */}
      <img
        src="/images/landing/shadow-bg.png"
        alt=""
        className="absolute inset-0 size-full object-cover opacity-[0.28] mix-blend-overlay select-none"
      />

      {/* Resolve into the page at the bottom only. A scrim at the *top* would
       * darken the exact place the light comes from, which is how the first
       * pass of this band ended up reading as a glow rising from the floor. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-b from-transparent to-[#0a0a0a]" />
    </div>
  );
}
