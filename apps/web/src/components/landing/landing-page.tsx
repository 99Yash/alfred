import { ArrowRight, Sparkles } from "lucide-react";
import { type ReactNode } from "react";
import {
  FadeInOnScroll,
  FloatingPillNav,
  FrostButton,
  LandingCtaSection,
  LandingFooter,
} from "~/components/landing";
import { BenefitsRow } from "~/components/landing/benefits-row";
import { FeatureGrid } from "~/components/landing/feature-grid";
import { HeroShowcase } from "~/components/landing/hero-showcase";
import { LandingBackground } from "~/components/landing/landing-background";
import { LandingSpine } from "~/components/landing/landing-spine";
import { cn } from "~/lib/utils";

/**
 * Marketing landing — synthesis of three sources:
 *   • dimension.dev — the sophisticated inbox/briefing hero panel
 *   • firstquadrant.ai — vertical spine line, dark canvas, max-w-5xl column
 *   • visitors.now — tabbed hero showcase + indigo aurora + 3-up benefits
 *
 * Structure (top → bottom): announcement bar → hero (eyebrows + headline +
 * sub + CTAs + tabbed product showcase with aurora behind it) → 3-up
 * benefits row → closing CTA → footer. Floating bottom nav over the top.
 */
function goToLogin() {
  window.location.assign("/login");
}

// Module-scope so the JSX object is stable across renders — the
// FloatingPillNav `cta` slot would otherwise receive a fresh node on every
// LandingPage re-render.
const NAV_CTA = (
  <FrostButton tone="light" size="sm" onClick={goToLogin}>
    Get Started
  </FrostButton>
);

export function LandingPage({
  healthOk,
  healthLoading,
}: {
  healthOk: boolean;
  healthLoading: boolean;
}) {
  return (
    <LandingBackground className="min-h-[100dvh] w-full overflow-x-hidden">
      <div className="relative mx-auto w-full max-w-5xl px-5 pb-16 sm:px-10 lg:px-0">
        <LandingSpine />

        <Hero onGetStarted={goToLogin} healthOk={healthOk} healthLoading={healthLoading} />

        <FadeInOnScroll className="mt-32 sm:mt-44">
          <div id="benefits">
            <BenefitsRow />
          </div>
        </FadeInOnScroll>

        <FeatureGrid className="mt-28 sm:mt-36" />

        <LandingCtaSection onGetStarted={goToLogin} />
      </div>

      <LandingFooter onGetStarted={goToLogin} healthOk={healthOk} />

      <FloatingPillNav
        logo={
          <a href="/" className="flex items-center gap-2">
            <img src="/images/logo/alfred-logo.svg" alt="Alfred" className="size-6 rounded-[7px]" />
            <span className="text-sm font-semibold text-white">Alfred</span>
          </a>
        }
        cta={NAV_CTA}
      >
        <a href="#benefits" className={NAV_LINK}>
          Why Alfred
        </a>
        <a href="#cta" className={NAV_LINK}>
          Pricing
        </a>
      </FloatingPillNav>
    </LandingBackground>
  );
}

const NAV_LINK =
  "rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-neutral-300 transition-colors hover:bg-white/5 hover:text-white";

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero({
  onGetStarted,
  healthOk,
  healthLoading,
}: {
  onGetStarted: () => void;
  healthOk: boolean;
  healthLoading: boolean;
}) {
  return (
    <section className="relative space-y-5 pt-32 text-center lg:pt-44">
      <FadeInOnScroll>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <EyebrowChip icon={<Sparkles className="size-3.5" strokeWidth={2} />} accent="indigo">
            Personal AI assistant
          </EyebrowChip>
          <EyebrowChip
            icon={
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  healthLoading ? "bg-neutral-400" : healthOk ? "bg-emerald-400" : "bg-amber-400",
                )}
              />
            }
            accent={healthLoading ? "neutral" : healthOk ? "emerald" : "amber"}
          >
            {healthLoading ? "Checking server…" : healthOk ? "Server online" : "Server unreachable"}
          </EyebrowChip>
        </div>
      </FadeInOnScroll>

      <FadeInOnScroll delay={80}>
        <h1
          className={cn(
            "mx-auto max-w-3xl text-balance font-semibold text-white",
            "text-[44px] leading-[1.05] tracking-[-0.045em] sm:text-5xl lg:text-6xl",
          )}
        >
          The AI coworker that never sleeps.
        </h1>
      </FadeInOnScroll>

      <FadeInOnScroll delay={140}>
        <p className="mx-auto max-w-2xl text-balance text-[16px] font-medium leading-[1.5] tracking-[-0.018em] text-neutral-400 sm:text-[18px]">
          Alfred connects to your email, calendar, and tools to triage your inbox, brief you each
          morning, and prepare you for every meeting, quietly, in the background.
        </p>
      </FadeInOnScroll>

      <FadeInOnScroll delay={200}>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-3">
          <FrostButton tone="light" size="lg" onClick={onGetStarted}>
            Get Started
            <ArrowRight className="size-4" />
          </FrostButton>
          <a
            href="#benefits"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2",
              "text-sm font-medium text-neutral-400 transition-colors hover:text-white",
            )}
          >
            Why Alfred
            <span aria-hidden>→</span>
          </a>
        </div>
      </FadeInOnScroll>

      <FadeInOnScroll delay={280} className="pt-12 sm:pt-16">
        <HeroShowcase />
      </FadeInOnScroll>
    </section>
  );
}

function EyebrowChip({
  children,
  icon,
  accent = "neutral",
}: {
  children: ReactNode;
  icon?: ReactNode;
  accent?: "neutral" | "emerald" | "indigo" | "amber";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        "text-[12px] font-medium tracking-tight",
        "border",
        accent === "emerald" && "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300",
        accent === "indigo" && "border-indigo-400/25 bg-indigo-400/[0.07] text-indigo-200",
        accent === "amber" && "border-amber-400/25 bg-amber-400/[0.07] text-amber-200",
        accent === "neutral" && "border-neutral-800 bg-neutral-900/60 text-neutral-300",
      )}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}
