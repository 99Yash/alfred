import { ArrowUpRight, Github, ShieldAlert } from "lucide-react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

const CONTACT_EMAIL = "yashgouravkar@gmail.com";
const REPO_URL = "https://github.com/99Yash/alfred";

/**
 * Access & verification notice — an honest callout that Alfred reads Gmail via
 * restricted scopes and therefore trips Google's "unverified app" screen, since
 * the verified badge for those scopes requires a CASA security assessment billed
 * yearly (hard to justify for a project of one). Amber-toned to read as a notice,
 * not a feature. Offers two ways in: ask for an allowlist seat, or self-host —
 * Alfred is fully open source.
 */
export function AccessNotice({ className }: { className?: string }) {
  return (
    <section
      id="access"
      className={cn("relative mx-auto w-full max-w-3xl scroll-mt-24", className)}
    >
      <FadeInOnScroll>
        <article
          className={cn(
            "relative isolate overflow-hidden rounded-[20px] p-7 sm:p-9",
            "border border-amber-400/20 bg-amber-400/4",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
            "transition-[translate,border-color,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            "hover:-translate-y-0.5 hover:border-amber-400/40 hover:bg-amber-400/6",
            "hover:shadow-[0_12px_38px_-14px_rgba(251,191,36,0.22),inset_0_1px_0_rgba(255,255,255,0.05)]",
          )}
        >
          <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber-400/20 bg-amber-400/8 text-amber-300">
              <ShieldAlert className="size-4" strokeWidth={2} aria-hidden />
            </span>

            <div className="flex flex-col gap-3">
              <h3 className="text-balance text-[18px] font-semibold leading-[1.3] tracking-[-0.02em] text-white sm:text-[20px]">
                Real access. Honest about the badge.
              </h3>

              <p className="text-pretty text-[14.5px] leading-[1.6] text-neutral-400 sm:text-[15px]">
                To work across your inbox, Alfred reads your email through the same restricted Gmail
                scopes Google reserves for serious products. The verified badge for those scopes
                takes a CASA security audit, billed{" "}
                <em className="not-italic text-neutral-300">every single year</em>. Hard to justify
                for a project of one. So Google greets you with an “unverified app” screen on the
                way in. The access is real. Only the badge is missing.
              </p>

              <p className="text-pretty text-[14.5px] leading-[1.6] text-neutral-400 sm:text-[15px]">
                Two ways in. Email me for a seat on the allowlist. Or skip the wait; Alfred is open
                source. Clone it, bring your own keys, or roll your own.
              </p>

              <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=Alfred%20access%20request`}
                  className={cn(
                    "press-scale group inline-flex w-fit items-center gap-1.5 rounded-full",
                    "border border-amber-400/25 bg-amber-400/8 px-3.5 py-2",
                    "text-[13.5px] font-medium text-amber-200",
                    "transition-colors duration-200 hover:bg-amber-400/[0.14] hover:text-amber-100",
                  )}
                >
                  {CONTACT_EMAIL}
                  <ArrowUpRight
                    className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    strokeWidth={2}
                    aria-hidden
                  />
                </a>

                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "press-scale group inline-flex w-fit items-center gap-1.5 rounded-full",
                    "border border-neutral-700/70 bg-white/3 px-3.5 py-2",
                    "text-[13.5px] font-medium text-neutral-300",
                    "transition-colors duration-200 hover:bg-white/6 hover:text-white",
                  )}
                >
                  <Github className="size-3.5" strokeWidth={2} aria-hidden />
                  Own your Alfred
                  <ArrowUpRight
                    className="size-3.5 text-neutral-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-neutral-300"
                    strokeWidth={2}
                    aria-hidden
                  />
                </a>
              </div>
            </div>
          </div>
        </article>
      </FadeInOnScroll>
    </section>
  );
}
