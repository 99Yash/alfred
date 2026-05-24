import { ArrowRight } from "lucide-react";
import { FrostButton } from "~/components/landing/frost-button";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/**
 * Closing CTA — quiet, centered, no card. Lives inside the page's max-w-5xl
 * spine wrapper so it inherits the same column width and the spine line
 * passes behind it.
 */
export function LandingCtaSection({
  onGetStarted,
}: {
  onGetStarted: () => void;
}) {
  return (
    <section
      id="cta"
      className="relative mx-auto max-w-3xl pt-32 pb-24 text-center sm:pt-44 sm:pb-32"
    >
      <FadeInOnScroll>
        <p className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-neutral-500">
          Get Started
        </p>
      </FadeInOnScroll>

      <FadeInOnScroll delay={80}>
        <h2
          className={cn(
            "mt-5 text-balance font-semibold text-white",
            "text-[40px] leading-[1.06] tracking-[-0.045em] sm:text-5xl lg:text-6xl",
          )}
        >
          Your smartest coworker starts today.
        </h2>
      </FadeInOnScroll>

      <FadeInOnScroll delay={140}>
        <p className="mx-auto mt-5 max-w-md text-[16px] font-medium leading-[1.5] tracking-[-0.018em] text-neutral-400 sm:text-[18px]">
          Connect your tools. Alfred starts working in under a minute.
        </p>
      </FadeInOnScroll>

      <FadeInOnScroll delay={200}>
        <div className="mt-8 inline-flex">
          <FrostButton tone="light" size="lg" onClick={onGetStarted}>
            Get started today
            <ArrowRight className="size-4" />
          </FrostButton>
        </div>
      </FadeInOnScroll>
    </section>
  );
}
