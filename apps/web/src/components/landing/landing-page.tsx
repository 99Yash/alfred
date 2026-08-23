import { ArrowRight, Sparkles } from "lucide-react";
import {
  AccessNotice,
  FadeInOnScroll,
  FloatingPillNav,
  FrostButton,
  LandingCtaSection,
  LandingFooter,
  LandingStatement,
} from "~/components/landing";
import { BenefitsRow } from "~/components/landing/benefits-row";
import { EyebrowChip } from "~/components/landing/eyebrow-chip";
import { FeatureGrid } from "~/components/landing/feature-grid";
import { HeroShowcase } from "~/components/landing/hero-showcase";
import { HowItWorks } from "~/components/landing/how-it-works";
import { LandingBackground } from "~/components/landing/landing-background";
import { cn } from "~/lib/utils";

/**
 * Marketing landing.
 *
 * The page is one continuous document, read top to bottom:
 *
 *   hero copy → the product, full-bleed → why you'd trust it → what happens
 *   when you sign up → what it does → why it matters → the honest caveat →
 *   the ask
 *
 * Two rules hold that shape together, and breaking either one is what made
 * the previous version read as a stack of unrelated screens on a black void:
 *
 * 1. **One rhythm, owned in one place.** Every band is `py-16 sm:py-20` over a
 *    `max-w-5xl px-5` column — see `LandingSection`. Sections do not carry
 *    their own margins. The two deliberate exceptions announce themselves:
 *    `LandingStatement` takes extra air because it is the crescendo, and
 *    `BenefitsRow` takes less because it is the caption on the product shot.
 *
 * 2. **Exactly one full-bleed moment.** `HeroShowcase` breaks the column,
 *    once, at the moment the reader first sees the product. Everything before
 *    and after it stays in the column, which is what makes the break read as
 *    emphasis instead of noise.
 *
 * Sources: the section grammar and the notch-over-band hero are visitors.now
 * (re-registered for a dark canvas); the device bezel is firstquadrant.ai; the
 * product clips are dimension's, pending Alfred-branded replacements.
 */
function goToLogin() {
  window.location.assign("/login");
}

// Module-scope so the JSX object is stable across renders — the
// FloatingPillNav `cta` slot would otherwise receive a fresh node on every
// LandingPage re-render.
const NAV_CTA = (
  <FrostButton tone="light" size="sm" onClick={goToLogin}>
    Sign in
  </FrostButton>
);

export function LandingPage() {
  return (
    <LandingBackground className="min-h-[100dvh] w-full overflow-x-hidden">
      {/* `<main>` gives the page its required primary landmark (the footer and
       * nav below are siblings, not part of the main content) — keeps
       * screen-reader "skip to main" working and clears Lighthouse's
       * landmark-one-main audit. */}
      <main className="relative w-full">
        <Hero onGetStarted={goToLogin} />

        <HeroShowcase />

        {/* The trust strip is the product shot's caption, so it sits tight
         * against the band rather than a section away. */}
        <div id="why" className="scroll-mt-24 pt-12 sm:pt-14">
          <BenefitsRow />
        </div>

        <HowItWorks />

        <FeatureGrid />

        <LandingStatement />

        <AccessNotice />

        <LandingCtaSection onGetStarted={goToLogin} />
      </main>

      <LandingFooter onGetStarted={goToLogin} />

      <FloatingPillNav
        logo={
          <a href="/" className="flex items-center gap-2">
            <img src="/images/logo/alfred-logo.svg" alt="Alfred" className="size-6 rounded-[7px]" />
            <span className="text-sm font-semibold text-white">Alfred</span>
          </a>
        }
        cta={NAV_CTA}
      >
        {/* Each label names what is actually there. "Home" and "Pricing" are
         * the kind of safe generic labels that tell a visitor nothing — and
         * this product has no pricing page to send them to. */}
        <a href="#features" className={NAV_LINK}>
          Features
        </a>
        <a href="#how-it-works" className={NAV_LINK}>
          How it works
        </a>
        <a href="#access" className={NAV_LINK}>
          Access
        </a>
      </FloatingPillNav>
    </LandingBackground>
  );
}

const NAV_LINK = cn(
  "rounded-full px-3 py-1.5 text-[13.5px] leading-[100%] font-medium text-neutral-300",
  "transition-colors duration-150 hover:bg-white/[0.07] hover:text-white",
);

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <section className="relative w-full pt-28 pb-14 sm:pt-36 sm:pb-16">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-5 text-center sm:px-6">
        <FadeInOnScroll>
          <EyebrowChip icon={<Sparkles className="size-3.5" strokeWidth={2} />} accent="indigo">
            Personal AI assistant
          </EyebrowChip>
        </FadeInOnScroll>

        <FadeInOnScroll delay={80}>
          {/* The largest type on the page, so the tightest tracking on the
           * page: letters read too far apart as they grow, and a single
           * letter-spacing value across a scale is wrong somewhere. */}
          <h1
            className={cn(
              "font-semibold text-balance text-white",
              "text-[40px] leading-[1.04] tracking-[-0.05em] sm:text-[54px] lg:text-[64px]",
            )}
          >
            The AI coworker that never sleeps.
          </h1>
        </FadeInOnScroll>

        <FadeInOnScroll delay={140}>
          <p className="mx-auto max-w-xl text-[16px] leading-[1.4] font-medium tracking-[-0.018em] text-balance text-neutral-400 sm:text-[18px]">
            Alfred connects to your Gmail
            <a
              href="#access"
              aria-label="A note on Gmail access and app verification"
              className="footnote-glow align-super text-[0.7em] font-semibold text-amber-300/90 transition-colors hover:text-amber-200"
            >
              *
            </a>
            , your calendar, and the tools you work in. Overnight it sorts the mail that arrived and
            writes your morning briefing. You wake up with one thing to read.
          </p>
        </FadeInOnScroll>

        <FadeInOnScroll delay={200}>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <FrostButton tone="light" size="lg" onClick={onGetStarted}>
              Get started
              <ArrowRight className="size-4" />
            </FrostButton>
            <a
              href="#how-it-works"
              className={cn(
                "group inline-flex items-center gap-1.5 rounded-full px-3.5 py-2.5",
                "text-[15px] font-medium text-neutral-400",
                "transition-colors duration-150 hover:bg-white/[0.05] hover:text-white",
              )}
            >
              See how it works
              <span
                aria-hidden
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
          </div>
        </FadeInOnScroll>
      </div>
    </section>
  );
}
