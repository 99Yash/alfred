import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Inbox,
  Lock,
  MailOpen,
  MessagesSquare,
  Search,
  Smartphone,
  Sparkles,
  Tags,
  Terminal,
  Timer,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { FrostButton, HeroAtmosphere, TopAnnouncement } from "~/components/landing";
import { GoogleConsentDialog } from "~/components/onboarding/google-consent-dialog";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

export type OnboardingStep = 1 | 2 | 3;

/**
 * Dimension-grammar onboarding shell. Same split-pane DNA as the landing —
 * sky gradient backdrop, sticky left rail with intro + headline + bullets +
 * step pager + CTA, right showcase panel that swaps content per step.
 *
 * Used by both the real /onboarding route and the /preview/onboarding
 * design-iteration route. State (current step, connected email, callbacks)
 * is fully prop-driven so the same shell handles both surfaces.
 */
export function OnboardingFlow({
  step,
  connectedEmail,
  connectedGithub,
  onConnect,
  onConnectGithub,
  onSkip,
  onFinish,
  finishing,
}: {
  step: OnboardingStep;
  connectedEmail?: string;
  connectedGithub?: string;
  onConnect: () => void;
  onConnectGithub: () => void;
  onSkip: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const localTime = useLocalTime();
  const active = STEPS[step - 1] ?? STEPS[0]!;

  // Step 1's CTA opens the consent-coaching dialog first; the dialog's
  // confirm runs the real `onConnect` redirect. Steps 2/3 act immediately.
  const [consentOpen, setConsentOpen] = useState(false);

  const primaryAction = (() => {
    if (step === 1)
      return { label: "Connect Google Workspace", onClick: () => setConsentOpen(true) };
    if (step === 2) return { label: "Continue", onClick: onSkip };
    return { label: "Start using Alfred", onClick: onFinish };
  })();

  return (
    <div className="relative isolate min-h-[100dvh] overflow-x-hidden bg-[#0c0c0c]">
      <GoogleConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        onConfirm={() => {
          setConsentOpen(false);
          onConnect();
        }}
      />
      <TopAnnouncement href="/login" dotClassName="bg-amber-200/70">
        Set up Alfred in under a minute
      </TopAnnouncement>

      <HeroAtmosphere className="min-h-[100dvh]">
        <div className="mx-auto flex min-h-[100dvh] w-full max-w-[100rem] flex-col lg:flex-row">
          {/* Left rail — sticky on desktop. Intro label, headline, bullets,
           * step pager (with active highlight + completed checks), CTA. */}
          <aside
            className={cn(
              "relative shrink-0 px-6 sm:px-10",
              "lg:sticky lg:top-0 lg:max-h-[100dvh] lg:max-w-[32rem] lg:pr-12 lg:pl-10",
              "lg:border-r-[0.5px] lg:border-black/10",
              "pt-24 pb-12 lg:pt-20 lg:pb-10",
            )}
          >
            <div className="flex h-full max-w-lg flex-col">
              <p className="text-[15px] font-medium text-white">
                Setting up Alfred · Step {step} of 3
              </p>
              <h1
                className={cn(
                  "mt-4 max-w-[20rem] font-medium text-balance text-white sm:max-w-none",
                  "text-4xl leading-[1.05] tracking-[-0.04em] sm:text-5xl",
                )}
              >
                {active.headline}
              </h1>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/90">
                {active.lead}
              </p>

              <ul className="mt-7 flex flex-col gap-3 text-white">
                {active.bullets.map((bullet) => (
                  <Bullet
                    key={bullet.text}
                    icon={<bullet.icon className="size-4" strokeWidth={2} />}
                  >
                    {bullet.text}
                  </Bullet>
                ))}
              </ul>

              {/* Stack on phones, inline on sm+ — assurance copy wraps
               * awkwardly next to the CTA on a narrow viewport. */}
              <div className="mt-7 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <FrostButton
                  tone="light"
                  onClick={primaryAction.onClick}
                  disabled={finishing && step === 3}
                >
                  {finishing && step === 3 ? "Finishing…" : primaryAction.label}
                  <ArrowRight className="size-3.5" />
                </FrostButton>
                {step === 2 && !connectedEmail ? null : (
                  <span className="text-xs text-white/55">{active.assurance}</span>
                )}
              </div>

              {step === 2 && connectedEmail ? (
                <p className="mt-4 inline-flex items-center gap-2 text-[12.5px] text-white/85">
                  <CheckCircle2 size={13} className="text-emerald-300" />
                  Google Workspace connected as{" "}
                  <span className="font-medium text-white">{connectedEmail}</span>
                </p>
              ) : null}

              {step === 2 && connectedGithub ? (
                <p className="mt-2 inline-flex items-center gap-2 text-[12.5px] text-white/85">
                  <CheckCircle2 size={13} className="text-emerald-300" />
                  GitHub connected as{" "}
                  <span className="font-medium text-white">@{connectedGithub}</span>
                </p>
              ) : null}

              {/* Step pager — pinned to the bottom of the left rail */}
              <div className="mt-10 lg:mt-auto lg:pt-10">
                <h2 className="mb-3 text-[17px] font-semibold text-white">Get set up</h2>
                <ul className="flex flex-col items-start">
                  {STEPS.map((s, idx) => {
                    const stepNumber = (idx + 1) as OnboardingStep;
                    const isActive = stepNumber === step;
                    const isDone = stepNumber < step;
                    return (
                      <li key={s.id} className="w-full">
                        <div
                          className={cn(
                            "group flex w-full items-center justify-between rounded-[10px] p-2 select-none",
                            "text-[15px] transition-colors duration-200",
                            isActive
                              ? "bg-white/[0.05] text-white"
                              : isDone
                                ? "text-white/85"
                                : "text-white/65",
                          )}
                          aria-current={isActive ? "step" : undefined}
                        >
                          <div className="flex items-center">
                            <span
                              className="flex shrink-0 items-center"
                              style={{ width: "auto", marginRight: 6 }}
                            >
                              <span
                                className={cn(
                                  "block h-5 w-[3px] rounded-[2px] transition-opacity duration-200",
                                  isActive ? "bg-[#73A7FF] opacity-100" : "bg-[#73A7FF] opacity-0",
                                )}
                              />
                            </span>
                            {s.pagerLabel}
                          </div>
                          <span className="tabular flex items-center gap-2 font-medium text-white/75 mix-blend-plus-lighter">
                            {isDone ? (
                              <CheckCircle2 size={14} className="text-emerald-300" />
                            ) : null}
                            {String(idx + 1).padStart(2, "0")}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </aside>

          {/* Right pane — showcase per step. `bg-black/10` only at `lg`
           * where the pane sits next to the rail; on mobile the pane
           * stacks BELOW the rail and the band reads as a hard seam.
           * `<main>` (paired with the rail's `<aside>`) is this chromeless
           * route's primary landmark. */}
          <main className="relative z-10 grow lg:bg-black/10">
            {/* Vertical tick ruler */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <svg
                aria-hidden
                className="absolute top-0 z-10 box-content h-full w-2 border-r border-white/10 px-1.5 pt-1"
              >
                <defs>
                  <pattern
                    id="onboarding-tick-ruler"
                    width="8"
                    height="16"
                    patternUnits="userSpaceOnUse"
                  >
                    <path d="M0 0H16M0" className="stroke-white/40" fill="none" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#onboarding-tick-ruler)" />
              </svg>
            </div>

            {/* Sticky locale + step header */}
            <div className="sticky top-0 z-30">
              <div
                aria-hidden
                className="absolute inset-0 left-5 bg-linear-to-b from-[#4867AF]/40 to-transparent"
              />
              <div className="relative ml-5 w-[calc(100%-20px)] pt-16">
                <p className="pl-5 text-[12.5px] font-bold tracking-[0.18em] text-white/55 uppercase mix-blend-plus-lighter">
                  Mumbai · {localTime} · {active.pagerLabel}
                </p>
                <div className="relative mt-4 h-px w-full bg-linear-to-r from-white/[0.05] to-white/50">
                  <div className="absolute -top-[5px] -left-[4.5px] z-40 grid size-2.5 place-items-center rounded-full bg-white/10">
                    <div className="size-1 rounded-full bg-white" />
                  </div>
                  <div className="absolute -top-[5px] -left-[14px] z-40 grid h-2.5 items-center">
                    <div className="h-px w-4 bg-white" />
                  </div>
                </div>
              </div>
            </div>

            {/* Step content */}
            <div className="relative flex flex-col pl-5">
              <div className="mx-auto flex w-full flex-col pt-4 pr-6 pb-32 pl-10 sm:pr-10">
                <div className="mb-6 flex flex-col gap-1.5">
                  <h3 className="text-[34px] leading-tight font-medium tracking-[-0.04em] text-white sm:text-[36px]">
                    {active.showcaseTitle}
                  </h3>
                  <p className="max-w-2xl pr-10 text-[15px] text-white/85">
                    {active.showcaseDescription}
                  </p>
                </div>

                {step === 1 ? <UnlockShowcase /> : null}
                {step === 2 ? (
                  <ConnectShowcase
                    connectedEmail={connectedEmail}
                    connectedGithub={connectedGithub}
                    onConnectGithub={onConnectGithub}
                  />
                ) : null}
                {step === 3 ? <FinishShowcase /> : null}
              </div>
            </div>
          </main>
        </div>
      </HeroAtmosphere>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step content                                                       */
/* ------------------------------------------------------------------ */

interface StepDef {
  id: string;
  pagerLabel: string;
  headline: string;
  lead: string;
  bullets: ReadonlyArray<{ icon: LucideIcon; text: string }>;
  assurance: string;
  showcaseTitle: string;
  showcaseDescription: string;
}

const STEPS: ReadonlyArray<StepDef> = [
  {
    id: "unlock",
    pagerLabel: "Unlock",
    headline: "Set up in under a minute.",
    lead: "Link your Google account so Alfred can work across your email, calendar, and files, then start working in the background.",
    bullets: [
      { icon: Sparkles, text: "Triages inbox and drafts replies in your tone" },
      { icon: Timer, text: "Briefs you each morning and after every meeting" },
      { icon: Lock, text: "Enterprise-grade encryption. Never used for training." },
    ],
    assurance:
      "Full access to your workspace, so Alfred can act for you. Revoke anytime from your Google account.",
    showcaseTitle: "What you'll unlock",
    showcaseDescription:
      "A taste of the features that come alive the moment Google Workspace is linked.",
  },
  {
    id: "connect",
    pagerLabel: "Connect",
    headline: "Connect the tools you live in.",
    lead: "Alfred works across your stack. Connect the apps you rely on so nothing falls through the cracks.",
    bullets: [
      { icon: MessagesSquare, text: "Slack — pull threads, never miss a mention" },
      { icon: Workflow, text: "Linear & GitHub — keep tickets and PRs in flow" },
      { icon: Inbox, text: "Google Workspace — Drive, Docs, Sheets, Slides" },
    ],
    assurance: "You're always in control. Critical actions need approval by default.",
    showcaseTitle: "Popular integrations",
    showcaseDescription: "Connect now or come back later — your setup syncs across every device.",
  },
  {
    id: "finish",
    pagerLabel: "Finish",
    headline: "Welcome to Alfred.",
    lead: "Setup is complete. Here are a few more ways to use Alfred — coming soon to your pocket and desktop.",
    bullets: [
      { icon: Sparkles, text: "Your morning briefing arrives at 7am tomorrow" },
      { icon: MessagesSquare, text: "Chat from the web now — mobile and CLI shortly" },
      { icon: Lock, text: "Approval gates already on for destructive actions" },
    ],
    assurance: "You can change schedules and gates anytime under Settings.",
    showcaseTitle: "Where Alfred shows up next",
    showcaseDescription: "Beyond the web app — Alfred is on its way to your desk and your phone.",
  },
];

/* -------- Step 1: What you'll unlock — feature grid ---------------- */

interface UnlockFeature {
  key: string;
  label: string;
  headline: string;
  body: string;
  icon: LucideIcon;
}

const UNLOCK_FEATURES: ReadonlyArray<UnlockFeature> = [
  {
    key: "briefing",
    label: "Morning Briefing",
    headline: "Wake up knowing what matters",
    body: "A one-screen digest of overnight inbox, calendar, and pending follow-ups.",
    icon: Sparkles,
  },
  {
    key: "drafting",
    label: "Auto Drafting",
    headline: "Replies drafted in your voice",
    body: "Alfred reads the thread, learns your tone, and prepares a reply you can send as-is.",
    icon: MailOpen,
  },
  {
    key: "labeling",
    label: "Labeling",
    headline: "Every email sorted automatically",
    body: "Receipts, newsletters, project updates — labeled into the right place.",
    icon: Tags,
  },
  {
    key: "search",
    label: "Search Files",
    headline: "Find anything in seconds",
    body: "Ask in plain English; Alfred searches across mail, drive, and notes in one shot.",
    icon: Search,
  },
  {
    key: "workflows",
    label: "Workflows",
    headline: "Custom automations",
    body: "Describe a recurring task; Alfred turns it into a workflow on schedule.",
    icon: Workflow,
  },
  {
    key: "meetings",
    label: "Meeting Prep",
    headline: "Walk in prepared",
    body: "Alfred drafts an agenda and pulls relevant context from past threads.",
    icon: CalendarClock,
  },
];

function UnlockShowcase() {
  return (
    <ShowcaseFrame>
      <div className="p-7">
        <p className="text-[12.5px] font-medium tracking-[0.16em] text-white/55 uppercase">
          What you'll unlock
        </p>
        <h4 className="mt-2 text-[34px] leading-[1.08] font-medium tracking-[-0.04em] text-white sm:text-[38px]">
          Six things Alfred handles
          <br />
          the moment you connect.
        </h4>
      </div>
      <div className="h-px w-full bg-linear-to-r from-white/40 via-white/10 to-transparent" />
      <ul className="grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-2">
        {UNLOCK_FEATURES.map((f) => (
          <li key={f.key} className="morning-briefing-surface flex items-start gap-3 p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/15 text-white ring-1 ring-white/20 backdrop-blur-sm ring-inset">
              <f.icon size={17} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-white">{f.headline}</p>
              <p className="mt-0.5 text-[13px] leading-[1.5] text-white/80">{f.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </ShowcaseFrame>
  );
}

/* -------- Step 2: Popular integrations ---------------------------
 *
 * Step 2 is a live connect surface for the integrations wired today.
 * Google Workspace is picked up via step 1; GitHub connects right here
 * (its OAuth callback 302s back to ?step=2&github_connected=…). The three
 * Google sub-features are "Included" once Workspace is linked, since they
 * share its OAuth scope. Linear/Slack plug in at m14 (MCP client) and are
 * honestly labelled "Soon". The rail's "Continue" CTA always advances —
 * connecting GitHub is optional. */

type IntegrationTileStatus = "included" | "connected" | "available" | "soon";

interface PopularIntegration {
  id: string;
  name: string;
  description: string;
  brand: IntegrationBrand;
  /** `included` if Google Workspace is linked; otherwise resolves to `soon`. */
  bundledWithGoogle?: boolean;
  /** Renders a live "Connect" pill that triggers `onConnectGithub`. */
  connectable?: boolean;
  /** Hard-coded default when neither bundled with Google nor connectable. */
  status: IntegrationTileStatus;
}

const POPULAR_INTEGRATIONS: ReadonlyArray<PopularIntegration> = [
  {
    id: "github",
    name: "GitHub",
    description: "Repos and pull requests",
    brand: "github",
    connectable: true,
    status: "available",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues and projects",
    brand: "linear",
    status: "soon",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Messages and channels",
    brand: "slack",
    status: "soon",
  },
  {
    id: "google_drive",
    name: "Google Drive",
    description: "Find and read your files",
    brand: "google_drive",
    status: "soon",
    bundledWithGoogle: true,
  },
  {
    id: "google_docs",
    name: "Google Docs",
    description: "Create and edit docs",
    brand: "google_docs",
    status: "soon",
    bundledWithGoogle: true,
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Work with spreadsheets",
    brand: "google_sheets",
    status: "soon",
    bundledWithGoogle: true,
  },
  {
    id: "google_slides",
    name: "Google Slides",
    description: "Create and edit decks",
    brand: "google_slides",
    status: "soon",
    bundledWithGoogle: true,
  },
];

function ConnectShowcase({
  connectedEmail,
  connectedGithub,
  onConnectGithub,
}: {
  connectedEmail?: string;
  connectedGithub?: string;
  onConnectGithub: () => void;
}) {
  return (
    <ShowcaseFrame>
      <div className="px-7 pt-7 pb-6">
        <p className="text-[12.5px] font-medium tracking-[0.16em] text-white/55 uppercase">
          Connect your tools
        </p>
        <h4 className="mt-2 text-[34px] leading-[1.08] font-medium tracking-[-0.04em] text-white sm:text-[38px]">
          Seven integrations.
          <br />
          One assistant.
        </h4>
      </div>
      <div className="h-px w-full bg-linear-to-r from-white/40 via-white/10 to-transparent" />
      <ul className="grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-2">
        {POPULAR_INTEGRATIONS.map((p) => {
          // GitHub connects live here; Google sub-features ride the Workspace
          // grant; everything else is honestly "Soon".
          const isGithubConnected = p.connectable && Boolean(connectedGithub);
          const status: IntegrationTileStatus = isGithubConnected
            ? "connected"
            : p.bundledWithGoogle
              ? connectedEmail
                ? "included"
                : "soon"
              : p.status;
          const detail =
            isGithubConnected && connectedGithub ? `@${connectedGithub}` : p.description;
          return (
            <li key={p.id} className="morning-briefing-surface flex items-center gap-3 px-5 py-4">
              <IntegrationIcon brand={p.brand} size="md" title={p.name} variant="frost" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-white">{p.name}</p>
                <p className="truncate text-[12.5px] text-white/75">{detail}</p>
              </div>
              {status === "available" ? (
                <ConnectPill onClick={onConnectGithub} label={`Connect ${p.name}`} />
              ) : (
                <IntegrationStatusBadge status={status} />
              )}
            </li>
          );
        })}
      </ul>
    </ShowcaseFrame>
  );
}

function ConnectPill({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-3.5 py-1 text-[12px] font-medium",
        "bg-white/15 text-white ring-1 ring-white/25 backdrop-blur-sm ring-inset",
        "transition-colors duration-150 hover:bg-white hover:text-[#0c0c0c] focus-visible:bg-white focus-visible:text-[#0c0c0c]",
        "focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none",
      )}
    >
      Connect
    </button>
  );
}

function IntegrationStatusBadge({ status }: { status: IntegrationTileStatus }) {
  if (status === "included" || status === "connected") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
          "bg-emerald-300/15 text-emerald-100 ring-1 ring-emerald-300/30 backdrop-blur-sm ring-inset",
        )}
      >
        <CheckCircle2 size={12} className="text-emerald-300" />
        {status === "connected" ? "Connected" : "Included"}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-3 py-1 text-[11.5px] font-medium tracking-[0.1em] uppercase",
        "bg-white/10 text-white/70 ring-1 ring-white/15 backdrop-blur-sm ring-inset",
      )}
    >
      Soon
    </span>
  );
}

/* -------- Step 3: Install tiles ---------------------------------- */

interface InstallTile {
  key: string;
  title: string;
  body: string;
  icon: LucideIcon;
  status: "soon" | "available";
}

const INSTALL_TILES: ReadonlyArray<InstallTile> = [
  {
    key: "desktop",
    title: "Desktop App",
    body: "One click from your dock",
    icon: Terminal,
    status: "soon",
  },
  {
    key: "imessage",
    title: "iMessage",
    body: "Chat with Alfred via text",
    icon: Inbox,
    status: "soon",
  },
  {
    key: "mobile",
    title: "Mobile App",
    body: "Alfred in your pocket",
    icon: Smartphone,
    status: "soon",
  },
];

function FinishShowcase() {
  return (
    <ShowcaseFrame>
      <div className="px-7 pt-7 pb-6">
        <p className="text-[12.5px] font-medium tracking-[0.16em] text-white/55 uppercase">
          You're all set
        </p>
        <h4 className="mt-2 text-[34px] leading-[1.08] font-medium tracking-[-0.04em] text-white sm:text-[38px]">
          Alfred is ready.
          <br />
          More surfaces coming soon.
        </h4>
      </div>
      <div className="h-px w-full bg-linear-to-r from-white/40 via-white/10 to-transparent" />
      <ul className="grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-3">
        {INSTALL_TILES.map((tile) => (
          <li key={tile.key} className="morning-briefing-surface flex flex-col gap-3 p-5">
            <span className="grid size-10 place-items-center rounded-xl bg-white/15 text-white ring-1 ring-white/20 backdrop-blur-sm ring-inset">
              <tile.icon size={18} strokeWidth={2} />
            </span>
            <div>
              <p className="text-[14px] font-semibold text-white">{tile.title}</p>
              <p className="mt-0.5 text-[13px] text-white/80">{tile.body}</p>
            </div>
            <span className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium tracking-[0.1em] text-white/70 uppercase ring-1 ring-white/15 ring-inset">
              Coming soon
            </span>
          </li>
        ))}
      </ul>
    </ShowcaseFrame>
  );
}

/* -------- Shared frame wrapper for all three showcases ------------ */

function ShowcaseFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-[28px]",
        "ring-1 ring-white/12 ring-inset",
        "shadow-[0_30px_80px_-30px_rgba(15,30,55,0.55)]",
        "morning-briefing-surface",
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                        */
/* ------------------------------------------------------------------ */

function Bullet({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 text-white" aria-hidden>
        {icon}
      </span>
      <span className="text-[15px] text-white">{children}</span>
    </li>
  );
}

function useLocalTime(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
