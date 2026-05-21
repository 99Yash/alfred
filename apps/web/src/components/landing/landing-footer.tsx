import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Closing footer — pixel-for-pixel adaptation of dimension's footer block.
 *
 * Structure:
 *  • Rounded-bottom white strip (`landing-footer-cap`) that "rises" from the
 *    sky above, with a drop-shadow.
 *  • Light gradient background (#e1e1e1 → #ffffff).
 *  • Outer grid of 1.5px hairlines on `border-black/10` forming cells.
 *  • Corner dots at every intersection (2px outer ring, 3.5px inner).
 *  • Big neumorphic "Alfred" wordmark + tagline + Get Started button on the
 *    left; three columns (Menu / Socials / Legal) with their own neumorphic
 *    headers staggered at delays 3.6s / 1.8s / 0s, matching dimension.
 *  • A bottom radial purple glow with soft-light blend below the footer.
 *
 * Will be personalized to Alfred's brand later — for now this is a faithful
 * port.
 */
export function LandingFooter({
  onGetStarted,
}: {
  onGetStarted: () => void;
}) {
  return (
    <footer
      id="landing-footer"
      className={cn(
        "relative w-full snap-start scroll-mt-0",
        // Min-height = full viewport so the footer occupies its own snap stop
        // and the bottom radial purple glow has room to read.
        "min-h-[100dvh] flex flex-col justify-center",
        "bg-gradient-to-b from-[#e1e1e1] to-[#ffffff]",
        "overflow-hidden text-gray-700",
        // Pull up under the rounded-cap so the cap visually fuses with the
        // light footer surface.
        "-mt-8 pt-8 md:-mt-16 md:pt-16",
      )}
    >
      {/* Sub-pixel hairline grid — top spacer row */}
      <div className="hidden items-center lg:flex">
        <div className="h-11 w-auto grow border-b-[1.5px] border-r-[1.5px] border-black/10" />
        <div className="flex w-full max-w-[97rem] shrink-0 items-center">
          <div className="h-11 w-full max-w-lg border-b-[1.5px] border-r-[1.5px] border-black/10" />
          <div className="hidden h-11 w-32 grow border-b-[1.5px] border-r-[1.5px] border-black/10 xl:block" />
          <div className="h-11 w-[640px] grow border-b-[1.5px] border-r-[1.5px] border-black/10" />
        </div>
        <div className="h-11 w-auto grow border-b-[1.5px] border-black/10" />
      </div>

      {/* Content row */}
      <div className="flex h-full flex-col items-center lg:flex-row">
        {/* Left spacer (lg+ only) */}
        <FooterCell className="hidden w-auto grow self-stretch lg:block" />

        <div className="flex w-full max-w-[97rem] shrink-0 flex-col items-center md:flex-row">
          {/* Brand cell */}
          <FooterCell className="self-stretch lg:max-w-lg">
            <div className="flex flex-col gap-6 px-6 py-10 lg:px-11">
              <div className="flex flex-col gap-2">
                <NeumorphicLight
                  className="text-5xl font-medium leading-none tracking-[-0.035em] sm:text-6xl lg:text-7xl"
                  delay={6}
                >
                  Alfred
                </NeumorphicLight>
                <p className="text-[15px] text-gray-700/70">
                  Your AI coworker that never sleeps.
                </p>
              </div>
              <div className="relative w-fit">
                <LightFrostButton onClick={onGetStarted}>
                  <span className="text-lg font-medium">Get Started</span>
                  <ArrowRight className="size-5" />
                </LightFrostButton>
                {/* Purple shimmer behind the button — matches dimension's
                  * `bg-[#6b62f2]/20 blur-lg` accent. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-0 h-full w-6 bg-[#6b62f2]/20 blur-lg"
                  style={{ left: "26%" }}
                />
              </div>
            </div>
          </FooterCell>

          {/* Middle spacer (xl+ only) */}
          <FooterCell className="hidden w-32 grow self-stretch xl:block" />

          {/* Three columns: Menu / Socials / Legal */}
          <div className="grow self-stretch border-b-[1.5px] border-r-[1.5px] border-black/10 lg:w-[640px]">
            <div className="flex flex-col items-center sm:flex-row">
              <FooterColumn title="Menu" delay={3.6} items={MENU_ITEMS} />
              <FooterColumn title="Socials" delay={1.8} items={SOCIAL_ITEMS} />
              <FooterColumn title="Legal" delay={0} items={LEGAL_ITEMS} last />
            </div>
          </div>
        </div>

        {/* Right spacer (lg+ only) */}
        <div className="hidden w-auto grow self-stretch border-b-[1.5px] border-black/10 lg:block" />
      </div>

      {/* Bottom spacer row */}
      <div className="hidden items-center lg:flex">
        <div className="h-16 w-auto grow border-b-[1.5px] border-r-[1.5px] border-black/10" />
        <div className="flex w-full max-w-[97rem] shrink-0 items-center">
          <div className="h-16 w-full max-w-lg border-b-[1.5px] border-r-[1.5px] border-black/10" />
          <div className="hidden h-16 w-32 grow border-b-[1.5px] border-r-[1.5px] border-black/10 xl:block" />
          <div className="h-16 w-[640px] grow border-b-[1.5px] border-r-[1.5px] border-black/10" />
        </div>
        <div className="h-16 w-auto grow border-b-[1.5px] border-black/10" />
      </div>

      {/* Bottom radial purple glow — matches dimension's
        * `radial-gradient(...rgb(107,98,242)...) soft-light blur(60.55px)`. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-0 right-0 h-80 w-full"
        style={{
          background:
            "radial-gradient(50% 50%, rgb(107, 98, 242) 0%, rgb(255, 255, 255) 100%)",
          mixBlendMode: "soft-light",
          filter: "blur(60.55px)",
        }}
      />
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Cell wrapper — adds the dimension-style 4-corner dot overlay.       */
/* ------------------------------------------------------------------ */

function FooterCell({
  children,
  className,
  noBorder,
}: {
  children?: ReactNode;
  className?: string;
  noBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative",
        !noBorder && "border-b-[1.5px] border-r-[1.5px] border-black/10",
        className,
      )}
    >
      {children}
      {/* Top-right outer dot */}
      <span
        aria-hidden
        className="absolute -right-[4.5px] -top-[4.5px] hidden size-2 place-items-center rounded-full bg-[#e1e1e1] lg:grid"
      >
        <span className="size-[3.5px] rounded-full bg-black/10" />
      </span>
      {/* Bottom-right inner dot (lighter ring so it reads on lighter bg) */}
      <span
        aria-hidden
        className="absolute -bottom-[4.5px] -right-[4.5px] z-10 hidden size-2 place-items-center rounded-full bg-[#fcfcfc] lg:grid"
      >
        <span className="size-[3.5px] rounded-full bg-black/10" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Column primitive — neumorphic header + link list                    */
/* ------------------------------------------------------------------ */

interface FooterLink {
  label: string;
  href: string;
}

const MENU_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "Pricing", href: "#cta" },
  { label: "Login", href: "/login" },
];

const SOCIAL_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "X", href: "https://x.com" },
  { label: "GitHub", href: "https://github.com/99Yash/alfred" },
];

const LEGAL_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "Privacy Policy", href: "/privacy-policy" },
  { label: "Terms of Service", href: "/terms-of-service" },
];

function FooterColumn({
  title,
  delay,
  items,
  last,
}: {
  title: string;
  delay: number;
  items: ReadonlyArray<FooterLink>;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex grow flex-col gap-4 self-stretch px-6 py-6 sm:pb-12 sm:pt-11",
        // Inner columns get bottom + right hairlines on small screens,
        // converting to right-only on lg+. The last column drops the right.
        !last && "border-b-[1.5px] border-r-[1.5px] border-black/10 lg:border-b-0",
        last && "lg:pr-11",
      )}
    >
      <NeumorphicLight
        className="text-3xl font-medium tracking-[-0.035em] sm:text-[40px] sm:leading-[48px]"
        delay={delay}
      >
        {title}
      </NeumorphicLight>
      <ul className="flex flex-col gap-4 sm:gap-5">
        {items.map((item) => (
          <li key={item.label}>
            <a
              href={item.href}
              className="text-[15px] text-gray-700/70 transition-colors hover:text-purple-700 hover:underline"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>

      {/* Corner dots */}
      <span
        aria-hidden
        className="absolute -right-[4.5px] -top-[4.5px] hidden size-2 place-items-center rounded-full bg-[#e1e1e1] lg:grid"
      >
        <span className="size-[3.5px] rounded-full bg-black/10" />
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-[4.5px] -right-[4.5px] hidden size-2 place-items-center rounded-full lg:grid",
          last ? "bg-white" : "bg-[#fcfcfc]",
        )}
      >
        <span className="size-[3.5px] rounded-full bg-black/10" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Light-on-light neumorphic text — dark text variant of               */
/* `.neumorphic-text` for the light footer surface.                    */
/* ------------------------------------------------------------------ */

function NeumorphicLight({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <p
      className={cn("neumorphic-text-on-light", className)}
      style={{ animationDelay: `${delay}s` }}
    >
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Light frost button — opaque white pill with subtle shadow stack.   */
/* ------------------------------------------------------------------ */

function LightFrostButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative isolate z-10 inline-flex w-64 select-none items-center justify-center gap-1.5",
        // NB: this project inverts Tailwind's gray scale, so `text-gray-950`
        // would render NEAR-WHITE on a light pill. Use a literal hex.
        "rounded-full px-4 py-2 text-[15px] font-medium text-[#0c0c0c]",
        "bg-gradient-to-b from-white/75 to-[#e3e3e3]",
        "transition hover:to-[#e3e3e3]/70 active:to-[#e3e3e3]/90",
        "shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.1),0px_18px_11px_0px_rgba(0,0,0,0.01),0px_8px_8px_0px_rgba(0,0,0,0.01),0px_2px_4px_0px_rgba(0,0,0,0.02),0px_-1px_0.1px_0.1px_rgba(255,255,255,0.75)_inset]",
        "hover:shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.1),0px_18px_11px_0px_rgba(0,0,0,0.015),0px_8px_8px_0px_rgba(0,0,0,0.015),0px_2px_4px_0px_rgba(0,0,0,0.025),0px_-1px_0.1px_0.1px_rgba(255,255,255,0.75)_inset]",
      )}
    >
      {children}
    </button>
  );
}
