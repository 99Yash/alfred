import { Moon } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/**
 * Positioning statement — a quiet, large-type manifesto in the Apple register.
 * The page's emotional crescendo: the *why* after the *what* and the *how*.
 *
 * This is the one place on the page allowed to break the section grammar.
 * Every other band is `py-16 sm:py-20` with a header and a grid; this one is
 * a single sentence in large type with air around it and nothing to click.
 * That is what makes it land — a page of evenly-packed sections has no
 * crescendo, and a page where every band shouts has no quiet.
 */
export function LandingStatement({ className }: { className?: string }) {
  return (
    <section className={cn("relative w-full py-20 sm:py-28", className)}>
      <div className="mx-auto max-w-3xl px-5 text-center sm:px-6">
        <FadeInOnScroll>
          <p className="text-[12px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
            The end of context-switching
          </p>
        </FadeInOnScroll>

        <FadeInOnScroll delay={80}>
          {/* Largest type on the page after the hero, so the tightest tracking
           * on the page after the hero. */}
          <h2
            className={cn(
              "mt-6 font-semibold text-balance text-white",
              "text-[34px] leading-[1.08] tracking-[-0.05em] sm:text-[44px] lg:text-[52px]",
            )}
          >
            Your focus, undivided.
            <br className="hidden sm:block" /> Everything else, handled.
          </h2>
        </FadeInOnScroll>

        <FadeInOnScroll delay={140}>
          <p className="mx-auto mt-6 max-w-xl text-[16px] leading-[1.55] font-medium tracking-[-0.018em] text-pretty text-neutral-400 sm:text-[18px]">
            Alfred reads the night, sorts what came in, and tells you the one thing that matters.
            Your attention stays on the work only you can do. No dozen tabs. No catching up.
          </p>
        </FadeInOnScroll>

        <FadeInOnScroll delay={200}>
          <p className="mt-8 inline-flex items-center gap-2 text-[15px] font-medium text-neutral-300">
            <span className="moon-glow inline-grid place-items-center">
              <Moon className="size-4 text-indigo-300" strokeWidth={2} aria-hidden />
            </span>
            And Alfred never sleeps.
          </p>
        </FadeInOnScroll>
      </div>
    </section>
  );
}
