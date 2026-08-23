import { Coffee, Link2, ShieldCheck, type LucideIcon } from "lucide-react";
import type { FunctionComponent } from "react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { LandingSection } from "~/components/landing/landing-section";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

interface Step {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Small illustration rendered above the copy. */
  figure: FunctionComponent;
}

/**
 * "Set up in three steps" — visitors.now's `Get started in minutes` row,
 * which answers the question a hero never can: *what actually happens after
 * I click the button?* A visitor who cannot picture the next three minutes
 * does not click.
 *
 * The three steps are the three real onboarding steps, not an invented
 * narrative — see `components/onboarding/onboarding-flow.tsx`, where `STEPS`
 * is literally Unlock → Connect → Finish, and the finish step promises the
 * first briefing "tomorrow" with approval gates already on. Copy here has to
 * keep matching that flow, because the visitor walks straight into it.
 */
export function HowItWorks() {
  return (
    <LandingSection
      id="how-it-works"
      eyebrow="How it works"
      title="Set up once, in three steps."
      lead="Link your account, choose what Alfred may touch, and go to bed. The first briefing lands in the morning."
      // One tonal change in the middle of the scroll, so the page reads as
      // three regions (the pitch, the mechanics, the caveat) rather than one
      // long fall through black.
      surface="raised"
    >
      <ol className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-5">
        {STEPS.map((step, idx) => (
          <FadeInOnScroll key={step.title} delay={idx * 90} as="li">
            <StepCard step={step} index={idx + 1} />
          </FadeInOnScroll>
        ))}
      </ol>
    </LandingSection>
  );
}

const STEPS: ReadonlyArray<Step> = [
  {
    icon: Link2,
    title: "Connect Google.",
    body: "One consent screen covers Gmail, Calendar, and Drive. Revoke it from your Google account whenever you want.",
    figure: ConnectFigure,
  },
  {
    icon: ShieldCheck,
    title: "Set the guardrails.",
    body: "Add GitHub, Notion, or Vercel if you use them. Anything destructive asks you first, out of the box.",
    figure: GuardrailFigure,
  },
  {
    icon: Coffee,
    title: "Wake up briefed.",
    body: "Alfred works overnight. Your first briefing arrives at 7am in your timezone, and your inbox is already sorted.",
    figure: BriefedFigure,
  },
];

function StepCard({ step, index }: { step: Step; index: number }) {
  const Icon = step.icon;
  const Figure = step.figure;
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-[20px]",
        "border border-white/[0.07] bg-white/[0.02]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        "transition-[border-color,translate] duration-200",
        "hover:-translate-y-0.5 hover:border-white/[0.12] motion-reduce:hover:translate-y-0",
      )}
    >
      {/* Figure sits above the copy: the reader sees the shape of the step
       * before reading what it is. */}
      <div className="relative grid h-[124px] place-items-center overflow-hidden border-b border-white/[0.05] bg-black/20 px-5">
        <Figure />
      </div>

      <div className="flex flex-col gap-2 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-neutral-300 ring-1 ring-white/10 ring-inset">
            {index}
          </span>
          <Icon className="size-3.5 text-indigo-300" strokeWidth={2} aria-hidden />
        </div>
        <h3 className="text-[17px] leading-[1.25] font-semibold tracking-[-0.03em] text-white">
          {step.title}
        </h3>
        <p className="text-[13.5px] leading-[1.55] tracking-[-0.01em] text-neutral-400">
          {step.body}
        </p>
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------------
 * Step figures — one small true illustration each, built from the same
 * primitives the rest of the page uses. Static: three looping animations
 * competing side by side would be noise, not life.
 * ------------------------------------------------------------------- */

/** Step 1 — the providers one Google consent actually covers. */
function ConnectFigure() {
  return (
    <div className="flex items-center gap-2.5">
      {(["gmail", "google_calendar", "google_drive"] as const).map((brand) => (
        <span
          key={brand}
          className="grid size-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        >
          <IntegrationGlyph brand={brand} size={18} />
        </span>
      ))}
    </div>
  );
}

/** Step 2 — the approval gate, shown as the prompt the user actually sees. */
function GuardrailFigure() {
  return (
    <div className="w-full max-w-[220px] rounded-xl border border-white/[0.08] bg-neutral-950/80 p-3">
      <p className="text-[11px] leading-[1.4] text-neutral-300">Archive 34 newsletters in Gmail?</p>
      <div className="mt-2.5 flex items-center gap-1.5">
        <span className="rounded-full bg-white px-2.5 py-1 text-[10.5px] font-semibold text-[#0c0c0c]">
          Approve
        </span>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10.5px] font-medium text-neutral-400">
          Deny
        </span>
      </div>
    </div>
  );
}

/** Step 3 — the briefing landing at its real default hour. */
function BriefedFigure() {
  return (
    <div className="flex w-full max-w-[220px] items-center gap-3 rounded-xl border border-white/[0.08] bg-neutral-950/80 px-3 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-orange-400/12 text-orange-300 ring-1 ring-orange-400/20 ring-inset">
        <Coffee className="size-3.5" strokeWidth={2} aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[11.5px] font-medium text-white">Your morning briefing</p>
        <p className="text-[10.5px] text-neutral-500 tabular-nums">7:00 AM · today</p>
      </div>
    </div>
  );
}
