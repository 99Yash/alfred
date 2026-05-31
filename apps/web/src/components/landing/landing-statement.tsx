import { Moon } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/**
 * Positioning statement — a quiet, large-type manifesto in the Apple register.
 * Sits between the feature grid and the closing CTA as the page's emotional
 * crescendo: the *why* (focus, no context-switching) after the *what* and *how*.
 */
export function LandingStatement({ className }: { className?: string }) {
  return (
    <section className={cn("relative mx-auto max-w-3xl text-center", className)}>
      <FadeInOnScroll>
        <p className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-neutral-500">
          The end of context-switching
        </p>
      </FadeInOnScroll>

      <FadeInOnScroll delay={80}>
        <h2
          className={cn(
            "mt-5 text-balance font-semibold text-white",
            "text-[34px] leading-[1.08] tracking-[-0.045em] sm:text-[44px] lg:text-5xl",
          )}
        >
          Your focus, undivided.
          <br className="hidden sm:block" /> Everything else, handled.
        </h2>
      </FadeInOnScroll>

      <FadeInOnScroll delay={140}>
        <p className="mx-auto mt-6 max-w-xl text-pretty text-[16px] font-medium leading-[1.6] tracking-[-0.018em] text-neutral-400 sm:text-[18px]">
          Alfred tags your email, preps you for every meeting, and quietly takes on the busywork a
          great assistant would. Your attention stays on the work only you can do. No dozen tabs. No
          catching up.
        </p>
      </FadeInOnScroll>

      <FadeInOnScroll delay={200}>
        <p className="mt-7 inline-flex items-center gap-2 text-[15px] font-medium text-neutral-300">
          <span className="moon-glow inline-grid place-items-center">
            <Moon className="size-4 text-indigo-300" strokeWidth={2} aria-hidden />
          </span>
          And Alfred never sleeps.
        </p>
      </FadeInOnScroll>
    </section>
  );
}
