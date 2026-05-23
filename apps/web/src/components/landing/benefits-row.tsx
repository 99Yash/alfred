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
    tagline: "One-user product. Not multi-tenant SaaS dressed up.",
  },
  {
    icon: KeyRound,
    lead: "Your keys.",
    tagline: "Bring-your-own model keys. We touch them, then forget.",
  },
  {
    icon: Moon,
    lead: "Never trained on.",
    tagline: "Your emails, your calendar, your data — never leaves to train.",
  },
];

/**
 * 3-up benefits row — visitors.now's "Lightweight script · 5-minute setup ·
 * Independent" pattern, adapted to Alfred's privacy-first story. Small
 * indigo-tinted icons + bold lead + muted tagline. Centered text on each
 * column.
 */
export function BenefitsRow({ className }: { className?: string }) {
  return (
    <section
      className={cn(
        "relative mx-auto w-full max-w-4xl",
        className,
      )}
    >
      <ul className="grid grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-6">
        {BENEFITS.map((b, idx) => (
          <FadeInOnScroll key={b.lead} delay={idx * 80} as="li">
            <div className="flex flex-col items-center text-center sm:items-start sm:text-left">
              <span className="grid size-10 place-items-center rounded-xl border border-indigo-400/20 bg-indigo-400/[0.06] text-indigo-300">
                <b.icon className="size-4" strokeWidth={2} />
              </span>
              <p className="mt-4 text-[15px] leading-[1.55] text-neutral-300">
                <span className="font-semibold text-white">{b.lead}</span>{" "}
                <span className="text-neutral-400">{b.tagline}</span>
              </p>
            </div>
          </FadeInOnScroll>
        ))}
      </ul>
    </section>
  );
}
