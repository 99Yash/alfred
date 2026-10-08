import { Moon } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/** The positioning statement: one large sentence with air around it, the page's one quiet band. */
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
          {/* Second-largest type, so the second-tightest tracking. */}
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
