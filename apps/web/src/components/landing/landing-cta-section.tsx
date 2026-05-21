import { ArrowRight } from "lucide-react";
import { MeshGradient } from "@paper-design/shaders-react";
import { FrostButton } from "~/components/landing";
import { cn } from "~/lib/utils";

/**
 * Closing-CTA section — mirrors dimension's "Your smartest coworker starts
 * today." block. A centered card with an animated mesh-gradient paper-shader
 * background (substitute for dimension's `cta-desktop-bg.png`), a small
 * eyebrow, oversized headline, subtitle, and frost CTA.
 */
export function LandingCtaSection({
  onGetStarted,
}: {
  onGetStarted: () => void;
}) {
  return (
    <section
      id="cta"
      className={cn(
        "relative w-full snap-start scroll-mt-[88px]",
        "min-h-[100dvh] grid place-items-center px-6 py-20 sm:px-12",
      )}
    >
      <div
        className={cn(
          "relative isolate w-full max-w-5xl overflow-hidden rounded-[36px]",
          "ring-1 ring-inset ring-white/12",
          "shadow-[0_40px_120px_-30px_rgba(15,30,55,0.55)]",
          "px-6 py-16 sm:px-14 sm:py-20",
        )}
      >
        {/* Animated mesh-gradient backdrop — replaces dimension's cta-desktop-bg.png */}
        <div className="pointer-events-none absolute inset-0 -z-10">
          <MeshGradient
            style={{ width: "100%", height: "100%" }}
            colors={["#4867AF", "#6f8be5", "#C49577", "#9CAFB8"]}
            distortion={0.45}
            swirl={0.15}
            speed={0.18}
          />
        </div>

        {/* Tint overlay so foreground reads on top of the moving colors */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[#0c0c0c]/35"
        />

        <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center text-center">
          <p className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-white/70">
            Get Started
          </p>
          <h2
            className={cn(
              "mt-3 text-balance font-medium tracking-[-0.02em] text-white",
              "text-[40px] leading-[1.06] sm:text-[52px] sm:leading-[1.05] lg:text-[60px]",
            )}
          >
            Your smartest coworker starts today.
          </h2>
          <p className="mt-5 max-w-md text-[16px] leading-relaxed text-white/85">
            Connect your tools. Alfred starts working in under a minute.
          </p>
          <div className="mt-9">
            <FrostButton tone="light" size="lg" onClick={onGetStarted}>
              Get started today
              <ArrowRight className="size-4" />
            </FrostButton>
          </div>
        </div>
      </div>
    </section>
  );
}
