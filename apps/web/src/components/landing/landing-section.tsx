import type { ReactNode } from "react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

/**
 * The landing page's vertical rhythm, in one place.
 *
 * Every marketing section on the page is the same shape: a `py-16 sm:py-20`
 * band, a `gap-12` split between the header block and the content, and one
 * `max-w-5xl px-5` column. That grammar is lifted from visitors.now, where
 * *every* section is literally `py-16 flex flex-col gap-12` over a
 * `max-w-5xl mx-auto px-5` column — which is why their page reads as one
 * continuous document instead of a stack of unrelated screens.
 *
 * Before this primitive existed, each Alfred section carried its own
 * `mt-32 sm:mt-44` (128–176px). Three sections in, the page was mostly
 * empty canvas. Owning the rhythm here means a spacing change is one edit,
 * not eight, and no section can drift out of step.
 *
 * Type scale follows the size-specific tracking rule: the bigger the text,
 * the tighter the tracking. See TITLE / LEAD below.
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
  /** Small uppercase-ish label above the title. Omit for an unheadered band. */
  eyebrow?: string | undefined;
  title?: ReactNode | undefined;
  lead?: ReactNode | undefined;
  children?: ReactNode | undefined;
  align?: "center" | "start" | undefined;
  /**
   * `raised` gives the band a barely-there lift and a hairline at each edge,
   * so it reads as its own region of the page. Use it sparingly — one tonal
   * change mid-scroll separates a structural region; three make stripes.
   */
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

/**
 * Section title. 36px at the reference width, `-0.05em` tracking — large
 * display text reads too loose at its natural spacing, so it tightens as it
 * grows, and the leading tightens with it (1.12 here vs 1.45 on body copy).
 */
const TITLE = cn(
  "max-w-2xl font-semibold text-balance text-white",
  "text-[30px] leading-[1.12] tracking-[-0.045em] sm:text-[36px] lg:text-[40px]",
);

/** Section lead. Body-register tracking (`-0.018em`) and a 1.4 leading. */
const LEAD = cn(
  "max-w-xl text-[16px] leading-[1.45] font-medium tracking-[-0.018em] text-pretty",
  "text-neutral-400 sm:text-[18px]",
);

/**
 * The small label above a section title. Deliberately not the hero's
 * `EyebrowChip` — this one is a flat uppercase word, so it recedes and lets
 * the title carry the section, where the hero chip is meant to be noticed.
 */
export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
      {children}
    </p>
  );
}

/** Shared card surface for the landing's panels. */
export const LANDING_CARD = cn(
  "relative isolate overflow-hidden rounded-[20px]",
  "border border-white/[0.07] bg-white/[0.02]",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
);
