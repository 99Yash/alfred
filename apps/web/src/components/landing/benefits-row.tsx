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

/**
 * The trust strip, directly under the hero band.
 *
 * This is not a section — it is the caption on the product shot above it,
 * and it is placed and scaled to read that way: a tight `py-10` band, no
 * heading, no eyebrow, hairline dividers between the three columns. The
 * proximity is the point. A visitor who has just watched Alfred read an inbox
 * has exactly one question, and it is about privacy; the answer has to be the
 * next thing they see, not a section away.
 *
 * Pattern from visitors.now's `Lightweight script · 5-minute setup ·
 * Independent` row, which sits in the same slot for the same reason.
 */
export function BenefitsRow({ className }: { className?: string }) {
  return (
    <section className={cn("relative w-full", className)}>
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-6">
        <ul
          className={cn(
            "grid grid-cols-1 gap-8",
            // Dividers rather than gutters at desktop: the three claims are
            // one statement in three parts, not three unrelated cards.
            "sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-white/[0.06]",
          )}
        >
          {BENEFITS.map((b, idx) => (
            <FadeInOnScroll key={b.lead} delay={idx * 70} as="li">
              <div
                className={cn(
                  "flex items-start gap-3 text-left",
                  // First column hugs the column edge, the rest are inset off
                  // their divider.
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
