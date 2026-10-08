import type { ReactNode } from "react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/**
 * The landing's one vertical rhythm: `py-16 sm:py-20`, `gap-12`, and a
 * `max-w-5xl px-5` column (from visitors.now). Sections carry no own margins.
 */
export function LandingSection({
  id,
  eyebrow,
  title,
  lead,
  children,
  align = "center",
  surface = "none",
  className,
  headerClassName,
}: {
  id?: string | undefined;
  /** Label above the title. Omit for a band with no header. */
  eyebrow?: string | undefined;
  title?: ReactNode | undefined;
  lead?: ReactNode | undefined;
  children?: ReactNode | undefined;
  align?: "center" | "start" | undefined;
  /** `raised` adds a faint lift and edge hairlines. Use it once; more makes stripes. */
  surface?: "none" | "raised" | undefined;
  className?: string | undefined;
  headerClassName?: string | undefined;
}) {
  const hasHeader = eyebrow != null || title != null || lead != null;

  return (
    <section
      id={id}
      className={cn(
        "relative w-full scroll-mt-24 py-16 sm:py-20",
        surface === "raised" &&
          "border-y border-white/[0.05] bg-linear-to-b from-white/[0.022] to-transparent",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 sm:gap-12 sm:px-6">
        {hasHeader ? (
          <FadeInOnScroll>
            <div
              className={cn(
                "flex flex-col gap-4",
                align === "center" ? "items-center text-center" : "items-start text-left",
                headerClassName,
              )}
            >
              {eyebrow ? <SectionEyebrow>{eyebrow}</SectionEyebrow> : null}
              {title ? <h2 className={TITLE}>{title}</h2> : null}
              {lead ? <p className={cn(LEAD, align === "center" && "mx-auto")}>{lead}</p> : null}
            </div>
          </FadeInOnScroll>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/** Large text tightens its tracking and leading as it grows. */
const TITLE = cn(
  "max-w-2xl font-semibold text-balance text-white",
  "text-[30px] leading-[1.12] tracking-[-0.045em] sm:text-[36px] lg:text-[40px]",
);

const LEAD = cn(
  "max-w-xl text-[16px] leading-[1.45] font-medium tracking-[-0.018em] text-pretty",
  "text-neutral-400 sm:text-[18px]",
);

/** A flat uppercase label, not the hero's `EyebrowChip`, so the title leads. */
export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
      {children}
    </p>
  );
}

export const LANDING_CARD = cn(
  "relative isolate overflow-hidden rounded-[20px]",
  "border border-white/[0.07] bg-white/[0.02]",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
);
