import { ArrowRight } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { FrostButton } from "~/components/landing/frost-button";
import { cn } from "~/lib/utils";

/**
 * Closing CTA — a panel, not another centered block of page.
 *
 * By this point the reader has scrolled past three centered headline blocks,
 * and a fourth one reads as the page repeating itself. Putting the ask on its
 * own contained surface makes it the last object on the page rather than the
 * last paragraph, which is what visitors.now does with the same slot
 * (`bg-background-subtle rounded-3xl px-8 py-16` inside the column).
 *
 * The panel carries the hero band's indigo, closing the loop: the page opens
 * on indigo light behind the product and ends on the same light behind the
 * button. If something appears one way, it should resolve the same way.
 */
export function LandingCtaSection({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <section id="cta" className="relative w-full scroll-mt-24 py-16 sm:py-20">
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-6">
        <FadeInOnScroll>
          <div
            className={cn(
              "relative isolate overflow-hidden rounded-[28px] px-6 py-16 text-center sm:px-10 sm:py-20",
              "border border-white/[0.08] bg-white/[0.02]",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
            )}
          >
            {/* Same light source as the hero band, from below this time — the
             * page's last object is lit by the same lamp as its first. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{
                background: [
                  "radial-gradient(80% 90% at 50% 108%, rgba(99, 102, 241, 0.28) 0%, transparent 68%)",
                  "radial-gradient(45% 60% at 50% 0%, rgba(167, 139, 250, 0.10) 0%, transparent 70%)",
                ].join(", "),
              }}
            />

            <p className="text-[12px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
              Get started
            </p>

            <h2
              className={cn(
                "mx-auto mt-5 max-w-2xl font-semibold text-balance text-white",
                "text-[32px] leading-[1.08] tracking-[-0.045em] sm:text-[42px] lg:text-[48px]",
              )}
            >
              Hand it the night shift.
            </h2>

            <p className="mx-auto mt-5 max-w-md text-[16px] leading-[1.45] font-medium tracking-[-0.018em] text-neutral-400 sm:text-[18px]">
              Connect Google, set the guardrails, and read your first briefing tomorrow morning.
            </p>

            <div className="mt-9 inline-flex">
              <FrostButton tone="light" size="lg" onClick={onGetStarted}>
                Get started
                <ArrowRight className="size-4" />
              </FrostButton>
            </div>
          </div>
        </FadeInOnScroll>
      </div>
    </section>
  );
}
