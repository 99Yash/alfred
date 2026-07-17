import {
  CalendarDays,
  Check,
  CornerDownRight,
  Inbox,
  MessagesSquare,
  Smartphone,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { cn } from "~/lib/utils";

type CardTone = "indigo" | "peach" | "rose" | "emerald";

interface FeatureCard {
  tone: CardTone;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  bullets: ReadonlyArray<string>;
  mockup: ReactNode;
}

/**
 * Visitors.now's "Everything you need" pattern adapted for Alfred —
 * a 2-column grid of feature cards. Each card has:
 *   • a tinted category icon + colored eyebrow
 *   • a big bold title
 *   • a one-line body
 *   • three bullet checkmarks
 *   • a stylized mockup at the bottom (45% of the card height)
 *
 * Sits between BenefitsRow and the closing CTA so the page tells a
 * narrative: who owns Alfred → what Alfred does → start.
 */
export function FeatureGrid({ className }: { className?: string }) {
  return (
    <section className={cn("relative mx-auto w-full", className)} id="features">
      <FadeInOnScroll>
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-[12px] font-medium tracking-tight text-neutral-300">
            Features
          </span>
          <h2
            className={cn(
              "mx-auto mt-5 max-w-2xl leading-[1.06] font-semibold tracking-[-0.045em] text-balance text-white",
              "text-[32px] sm:text-[40px] lg:text-[44px]",
            )}
          >
            Everything Alfred handles for you.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-[1.5] font-medium tracking-[-0.018em] text-balance text-neutral-400 sm:text-[17px]">
            One assistant, across every tool you already use. Nothing important slips by.
          </p>
        </div>
      </FadeInOnScroll>

      <div className="mt-14 grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        {FEATURES.map((card, idx) => (
          <FadeInOnScroll key={card.title} delay={idx * 80}>
            <FeatureCardView card={card} />
          </FadeInOnScroll>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------------
 * Card content
 * ------------------------------------------------------------------- */

const FEATURES: ReadonlyArray<FeatureCard> = [
  {
    tone: "indigo",
    icon: Inbox,
    eyebrow: "Inbox triage",
    title: "Drafts replies in your tone.",
    body: "Triages every overnight thread, archives the noise, and drafts replies only for the threads that actually want one.",
    bullets: [
      "Learns your tone from your sent mail",
      "Archives newsletters + receipts on its own",
      "Marks the four threads worth your morning",
    ],
    mockup: <InboxRowMockup />,
  },
  {
    tone: "peach",
    icon: Sun,
    eyebrow: "Morning briefing",
    title: "One paragraph at 6 AM.",
    body: "Collates overnight updates from your calendar, inbox, and chat into a thirty-second readout you can scan over coffee.",
    bullets: [
      "Built from your calendar + inbox + chat",
      "Synced before you wake, in your timezone",
      "Skips low-signal updates",
    ],
    mockup: <BriefingPillMockup />,
  },
  {
    tone: "rose",
    icon: CalendarDays,
    eyebrow: "Meeting prep",
    title: "Walks you in informed.",
    body: "Eight minutes before a meeting, Alfred surfaces what your guest's been working on, what they're stuck on, and what's worth raising.",
    bullets: [
      "Pulls from email, Slack, and Linear",
      "Three takeaways, never more",
      "Surfaces what they Slacked at midnight",
    ],
    mockup: <MeetingPrepMockupCard />,
  },
  {
    tone: "emerald",
    icon: Smartphone,
    eyebrow: "Anywhere",
    title: "Talk to it from any tool.",
    body: "Chat with Alfred from the web, your phone, the terminal, or any iMessage thread. Same memory, same context, every time.",
    bullets: [
      "iMessage, Slack, browser, and CLI",
      "Persistent memory across sessions",
      "Knows what you asked yesterday",
    ],
    mockup: <ChatBubbleMockup />,
  },
];

/* ----------------------------------------------------------------------
 * Card chrome
 * ------------------------------------------------------------------- */

const TONE_ACCENT: Record<CardTone, { text: string; bg: string; ring: string; glow: string }> = {
  indigo: {
    text: "text-indigo-300",
    bg: "bg-indigo-400/[0.08]",
    ring: "ring-indigo-400/20",
    glow: "rgb(129 140 248 / 0.16)",
  },
  peach: {
    text: "text-orange-300",
    bg: "bg-orange-400/[0.08]",
    ring: "ring-orange-400/20",
    glow: "rgb(251 146 60 / 0.16)",
  },
  rose: {
    text: "text-rose-300",
    bg: "bg-rose-400/[0.08]",
    ring: "ring-rose-400/20",
    glow: "rgb(251 113 133 / 0.16)",
  },
  emerald: {
    text: "text-emerald-300",
    bg: "bg-emerald-400/[0.08]",
    ring: "ring-emerald-400/20",
    glow: "rgb(52 211 153 / 0.16)",
  },
};

function FeatureCardView({ card }: { card: FeatureCard }) {
  const tone = TONE_ACCENT[card.tone];
  const Icon = card.icon;
  return (
    <article
      className={cn(
        "group relative isolate flex h-full flex-col overflow-hidden rounded-[20px]",
        "border border-neutral-800/80 bg-neutral-950/60",
        "transition-[border-color,translate] duration-200 hover:border-neutral-700/80",
        // A whisper of lift on hover so the card feels liftable, not just tinted.
        "hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
        // Subtle inner highlight so the card edge catches a hint of light,
        // matching the frosted-bezel rhythm used elsewhere on the page.
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
      )}
    >
      {/* Tone-matched glow that warms the top edge on hover — the card's
          accent bleeding up through the frosted surface. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-px h-32 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `radial-gradient(60% 100% at 50% 0%, ${tone.glow}, transparent 72%)` }}
      />

      {/* Copy block */}
      <div className="flex flex-col gap-3 p-7 sm:p-8">
        <span
          className={cn(
            "grid size-9 place-items-center rounded-xl ring-1 ring-inset",
            tone.bg,
            tone.ring,
          )}
        >
          <Icon className={cn("size-4", tone.text)} strokeWidth={2} />
        </span>
        <p className={cn("text-[13px] font-semibold tracking-tight", tone.text)}>{card.eyebrow}</p>
        <h3 className="max-w-[22ch] text-[22px] leading-[1.18] font-semibold tracking-[-0.035em] text-balance text-white sm:text-[24px]">
          {card.title}
        </h3>
        <p className="max-w-[36ch] text-[14.5px] leading-[1.55] tracking-[-0.012em] text-neutral-400">
          {card.body}
        </p>
        <ul className="mt-2 space-y-1.5">
          {card.bullets.map((b) => (
            <li
              key={b}
              className="flex items-start gap-2 text-[13.5px] leading-[1.5] text-neutral-300"
            >
              <Check className={cn("mt-[3px] size-3.5 shrink-0", tone.text)} strokeWidth={2.6} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Mockup */}
      <div className="mt-auto flex min-h-[160px] items-end justify-center px-6 pb-7 sm:px-8 sm:pb-8">
        <div className="w-full">{card.mockup}</div>
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------------
 * Per-card mockups — small static illustrations, NOT full mockups. Echoes
 * of the hero panels but stripped to one or two essential elements so each
 * card reads at a glance.
 * ------------------------------------------------------------------- */

function InboxRowMockup() {
  return (
    <div className="space-y-1.5">
      {[
        {
          name: "Anika",
          subject: "Re: auth migration, staged today",
          chip: "Drafted",
          tone: "rose" as const,
        },
        {
          name: "Dana",
          subject: "Q3 roadmap needs your take",
          chip: "Drafted",
          tone: "peach" as const,
        },
        {
          name: "Vercel",
          subject: "Domain settings updated",
          chip: "Archived",
          tone: "violet" as const,
        },
      ].map((row) => (
        <div
          key={row.name}
          className="fg-row flex items-center gap-3 rounded-xl border border-neutral-800/80 bg-neutral-900/60 px-3 py-2.5"
        >
          <MiniAvatar initial={row.name[0] ?? "?"} tone={row.tone} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-white">{row.name}</span>
              <MiniChip kind={row.chip === "Drafted" ? "drafted" : "archived"} className="fg-stamp">
                {row.chip}
              </MiniChip>
            </p>
            <p className="mt-0.5 truncate text-[12.5px] text-neutral-400">{row.subject}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function BriefingPillMockup() {
  return (
    <div className="space-y-2 rounded-xl border border-neutral-800/80 bg-neutral-900/60 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium tracking-[0.16em] text-neutral-500 uppercase">
          Mumbai · 24°
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300 ring-1 ring-emerald-400/20 ring-inset">
          <span className="relative grid size-1.5 place-items-center" aria-hidden>
            <span className="fg-ping absolute inset-0 rounded-full bg-emerald-300" />
            <span className="relative size-1.5 rounded-full bg-emerald-300" />
          </span>
          Synced 6:42 AM
        </span>
      </div>
      <p className="text-[14px] leading-[1.5] text-neutral-200">
        Good morning. You have <MiniPill tone="indigo">4 meetings</MiniPill> but a free{" "}
        <MiniPill tone="peach">afternoon</MiniPill>.
      </p>
      <div className="h-px w-full bg-linear-to-r from-neutral-700 via-neutral-800 to-transparent" />
      <p className="flex items-center gap-2 text-[12.5px] text-neutral-400">
        <CornerDownRight className="size-3" strokeWidth={2} />
        Marcus flagged the checkout bug in #Eng.
      </p>
    </div>
  );
}

function MeetingPrepMockupCard() {
  return (
    <div className="space-y-3 rounded-xl border border-neutral-800/80 bg-neutral-900/60 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium tracking-[0.16em] text-neutral-500 uppercase">
          Design sync · 3:00 PM
        </span>
        <span className="fg-tick ml-auto inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-300 ring-1 ring-amber-400/20 ring-inset">
          In 8 min
        </span>
      </div>
      <div className="flex items-center gap-2">
        <MiniAvatar initial="A" tone="rose" />
        <span className="text-[13px] font-medium text-white">Anika</span>
        <span className="text-[13px] text-neutral-400">· Design</span>
      </div>
      <div className="space-y-1.5">
        <p className="fg-row flex items-center gap-2 text-[12.5px] text-neutral-300">
          <MiniChip kind="hint">On her mind</MiniChip>
          Auth migration ENG-341
        </p>
        <p className="fg-row flex items-center gap-2 text-[12.5px] text-neutral-300">
          <MiniChip kind="warn">Heads up</MiniChip>
          Slacked at midnight
        </p>
      </div>
    </div>
  );
}

/**
 * The one mockup that earns a real sequence: a question goes out, Alfred
 * "thinks" (typing dots), then the answer lands. Plays once when the card
 * scrolls into view; reduced-motion users see the finished exchange up front.
 */
function ChatBubbleMockup() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<"idle" | "asked" | "typing" | "done">(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "done"
      : "idle",
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        obs.disconnect();
        setPhase("asked");
        typingTimer = setTimeout(() => setPhase("typing"), 620);
        doneTimer = setTimeout(() => setPhase("done"), 1640);
      },
      { threshold: 0.45 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      if (typingTimer) clearTimeout(typingTimer);
      if (doneTimer) clearTimeout(doneTimer);
    };
  }, []);

  return (
    <div ref={ref} className="min-h-[104px] space-y-2">
      {phase !== "idle" && (
        <div className="fg-msg-in flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-[6px] bg-emerald-500/85 px-3.5 py-2 text-[13.5px] leading-[1.4] text-emerald-950">
            What did Marcus end up shipping yesterday?
          </div>
        </div>
      )}

      {phase === "typing" && (
        <div className="fg-msg-in flex items-end gap-2">
          <img
            src="/images/logo/alfred-logo.svg"
            alt="Alfred"
            className="size-6 shrink-0 rounded-[7px]"
          />
          <div className="flex items-center gap-1 rounded-2xl rounded-bl-[6px] border border-neutral-800/80 bg-neutral-900/80 p-3">
            <span className="fg-typing-dot size-1.5 rounded-full bg-neutral-400" />
            <span className="fg-typing-dot size-1.5 rounded-full bg-neutral-400" />
            <span className="fg-typing-dot size-1.5 rounded-full bg-neutral-400" />
          </div>
        </div>
      )}

      {phase === "done" && (
        <>
          <div className="fg-msg-in flex items-start gap-2">
            <img
              src="/images/logo/alfred-logo.svg"
              alt="Alfred"
              className="mt-1 size-6 shrink-0 rounded-[7px]"
            />
            <div className="max-w-[80%] rounded-2xl rounded-bl-[6px] border border-neutral-800/80 bg-neutral-900/80 px-3.5 py-2 text-[13.5px] leading-[1.4] text-neutral-200">
              The checkout webhook fix in <MiniPill tone="violet">#Eng</MiniPill>. Three customers
              refunded.
            </div>
          </div>
          <p className="fg-msg-in ml-8 inline-flex items-center gap-1.5 text-[10.5px] tracking-[0.14em] text-neutral-500 uppercase">
            <MessagesSquare className="size-3" strokeWidth={2} />
            iMessage · Slack · Web · CLI
          </p>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Mini primitives shared by the embedded mockups.
 * ------------------------------------------------------------------- */

type MiniAvatarTone = "indigo" | "violet" | "peach" | "rose" | "emerald";

const MINI_AVATAR_BG: Record<MiniAvatarTone, string> = {
  indigo: "bg-indigo-400/30 text-indigo-200 ring-indigo-400/30",
  violet: "bg-violet-400/30 text-violet-200 ring-violet-400/30",
  peach: "bg-orange-400/30 text-orange-200 ring-orange-400/30",
  rose: "bg-rose-400/30 text-rose-200 ring-rose-400/30",
  emerald: "bg-emerald-400/30 text-emerald-200 ring-emerald-400/30",
};

function MiniAvatar({ initial, tone }: { initial: string; tone: MiniAvatarTone }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ring-1 ring-inset",
        MINI_AVATAR_BG[tone],
      )}
    >
      {initial}
    </span>
  );
}

const MINI_CHIP_STYLES: Record<"drafted" | "archived" | "hint" | "warn", string> = {
  drafted: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
  archived: "bg-neutral-800 text-neutral-400 ring-neutral-700",
  hint: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
  warn: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
};

function MiniChip({
  children,
  kind,
  className,
}: {
  children: ReactNode;
  kind: "drafted" | "archived" | "hint" | "warn";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5",
        "text-[10px] font-semibold tracking-[0.1em] uppercase",
        "ring-1 ring-inset",
        MINI_CHIP_STYLES[kind],
        className,
      )}
    >
      {children}
    </span>
  );
}

const MINI_PILL_TONES: Record<"indigo" | "peach" | "violet", string> = {
  indigo: "bg-indigo-400/15 text-indigo-200 ring-indigo-400/25",
  peach: "bg-orange-400/15 text-orange-200 ring-orange-400/25",
  violet: "bg-violet-400/15 text-violet-200 ring-violet-400/25",
};

function MiniPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "indigo" | "peach" | "violet";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-[2px]",
        "text-[12px] font-medium",
        "ring-1 ring-inset",
        MINI_PILL_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
