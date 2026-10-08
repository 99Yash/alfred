import { KeyRound, Moon, User2, type LucideIcon } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

interface Benefit {
  icon: LucideIcon;
  lead: string;
  tagline: string;
}

const BENEFITS: ReadonlyArray<Benefit> = [
  {
    icon: User2,
    lead: "Yours alone.",
    tagline: "A product for one person. Not multi-tenant SaaS dressed up.",
  },
  {
    icon: KeyRound,
    lead: "Sealed credentials.",
    tagline: "Your tokens are encrypted at rest and never leave the server.",
  },
  {
    icon: Moon,
    lead: "Never trained on.",
    tagline: "Your mail and your calendar are yours. No model learns from them.",
  },
];

/** Trust strip: the caption under the hero band, so it is tight and has no heading. */
export function BenefitsRow({ className }: { className?: string }) {
  return (
    <section className={cn("relative w-full", className)}>
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-6">
        <ul
          className={cn(
            "grid grid-cols-1 gap-8",
            // Dividers, not gutters: one statement in three parts.
            "sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-white/[0.06]",
          )}
        >
          {BENEFITS.map((b, idx) => (
            <FadeInOnScroll key={b.lead} delay={idx * 70} as="li">
              <div
                className={cn(
                  "flex items-start gap-3 text-left",
                  idx === 0 ? "sm:pr-6" : "sm:px-6",
                  idx === BENEFITS.length - 1 && "sm:pr-0",
                )}
              >
                <span className="mt-px grid size-8 shrink-0 place-items-center rounded-lg border border-indigo-400/20 bg-indigo-400/[0.06] text-indigo-300">
                  <b.icon className="size-[15px]" strokeWidth={2} aria-hidden />
                </span>
                <p className="text-[14px] leading-[1.5] tracking-[-0.012em]">
                  <span className="font-semibold text-white">{b.lead}</span>{" "}
                  <span className="text-neutral-400">{b.tagline}</span>
                </p>
              </div>
            </FadeInOnScroll>
          ))}
        </ul>
      </div>
    </section>
  );
}
