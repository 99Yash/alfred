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
 * Marketing landing, one continuous document.
 * Every band uses `LandingSection`'s rhythm; only `LandingStatement` and `BenefitsRow`
 * differ on purpose. `HeroShowcase` is the one full-bleed break.
 */
function goToLogin() {
  window.location.assign("/login");
}

// Module scope keeps the `cta` node stable across renders.
const NAV_CTA = (
  <FrostButton tone="light" size="sm" onClick={goToLogin}>
    Sign in
  </FrostButton>
);

export function LandingPage() {
  return (
    <LandingBackground className="min-h-[100dvh] w-full overflow-x-hidden">
      {/* The one primary landmark; nav and footer sit outside it. */}
      <main className="relative w-full">
        <Hero onGetStarted={goToLogin} />

        <HeroShowcase />

        {/* The trust strip captions the product shot, so it sits tight against the band. */}
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
        {/* Labels name what is there. There is no pricing page. */}
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
          {/* Largest type, so the tightest tracking: letters drift apart as they grow. */}
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
