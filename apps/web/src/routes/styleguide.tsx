/**
 * Internal styleguide — Before/After preview of Alfred's two design grammars.
 *
 * Visit /styleguide on a dev build and toggle between:
 *   • After — the Visitors-revamp landing grammar (FrostButton, EyebrowChip,
 *     AuroraGlow, DeviceBezel, FeatureGrid, etc.) used by the marketing
 *     surface in components/landing/*.
 *   • Before — the Dimension primitives still powering the in-app surfaces
 *     (Button, IconButton, Card, FrostPanel, CommandPalette, …) from
 *     components/ui/*. Kept verbatim because we still rely on them everywhere
 *     inside the authenticated app, and a lot of the recipes (frost-border,
 *     gray ramp, lavender heading) carry forward into the new grammar.
 *
 * Add new primitives to the appropriate half as they're built. Cross-reference
 * references/dimension-dev/dimension-design-reference-2026-05-18.md §2 for the
 * Dimension recipes; the Visitors half is the source of truth for the new
 * marketing direction (see components/landing/landing-page.tsx).
 */

import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import {
  Archive,
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  History as HistoryIcon,
  Home,
  LogOut,
  Mail,
  Mic,
  MoonStar,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { CommandPalette } from "~/components/ui/command-palette";
import { FrostPanel } from "~/components/ui/frost-panel";
import { IconButton } from "~/components/ui/icon-button";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import { StatusDot } from "~/components/ui/status-dot";
import { Switch } from "~/components/ui/switch";
import { Tabs } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { QuickAccessRail } from "~/components/quick-access-rail";
import { DimensionChatThread } from "~/components/dimension-chat-thread";
import { AuroraGlow } from "~/components/landing/aurora-glow";
import { BenefitsRow } from "~/components/landing/benefits-row";
import { DeviceBezel } from "~/components/landing/device-bezel";
import { FadeInOnScroll } from "~/components/landing/fade-in-on-scroll";
import { FrostButton } from "~/components/landing/frost-button";
import { HeroShowcase } from "~/components/landing/hero-showcase";
import { LandingBackground } from "~/components/landing/landing-background";
import { LandingCtaSection } from "~/components/landing/landing-cta-section";
import { LandingFooter } from "~/components/landing/landing-footer";
import { MorningBriefingPanel } from "~/components/landing/morning-briefing-panel";
import { TabPill } from "~/components/landing/tab-pill";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/styleguide")({
  head: () => pageMeta({ title: "Styleguide", path: "/styleguide" }),
  component: StyleguidePage,
});

type StyleguideMode = "visitors" | "dimension";

function StyleguidePage() {
  const [mode, setMode] = useState<StyleguideMode>("visitors");

  return (
    <div className="h-full overflow-y-auto bg-[#0a0a0a] text-gray-950">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 space-y-12">
        <header className="space-y-4">
          <p className="text-sm text-gray-800">Internal · Before / After preview</p>
          <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
            Alfred UI styleguide
          </h1>
          <p className="text-sm text-gray-800 max-w-prose">
            Toggle between the new <strong className="text-white">Visitors revamp</strong> landing
            grammar and the <strong className="text-white">Dimension</strong> primitives that still
            power the in-app surfaces. Both halves are kept side-by-side on purpose — Dimension
            recipes (gray ramp, frost-border, lavender headings) carry forward into the new
            direction and are not going away.
          </p>
          <div className="pt-1">
            <Tabs
              variant="pill"
              value={mode}
              onValueChange={(next) => setMode(next as StyleguideMode)}
              items={[
                {
                  value: "visitors",
                  label: "After · Visitors revamp",
                  icon: <Sparkles size={14} />,
                },
                { value: "dimension", label: "Before · Dimension", icon: <MoonStar size={14} /> },
              ]}
            />
          </div>
        </header>

        {mode === "visitors" ? <VisitorsHalf /> : <DimensionHalf />}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dimension half — the original primitives, untouched.                        */
/* -------------------------------------------------------------------------- */

function DimensionHalf() {
  return (
    <div className="space-y-16">
      <HalfBanner
        tone="dimension"
        eyebrow="Before"
        title="Dimension primitives"
        body="Every primitive in apps/web/src/components/ui/ rendered with default / hover / focus / active / disabled states. These power every authenticated surface — chat, settings, command palette, the right rail."
      />
      <TokensSection />
      <ButtonSection />
      <IconButtonSection />
      <InputSection />
      <TextareaSection />
      <SwitchSection />
      <TabsSection />
      <ChatThreadSection />
      <QuickAccessRailSection />
      <CardSection />
      <FrostPanelSection />
      <AvatarSection />
      <KbdSection />
      <StatusDotSection />
      <FrostBorderSection />
      <CommandPaletteSection />
      <TypographySection />
    </div>
  );
}

function HalfBanner({
  tone,
  eyebrow,
  title,
  body,
}: {
  tone: "visitors" | "dimension";
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div
      className={cn(
        "rounded-3xl border px-6 py-5",
        tone === "visitors"
          ? "border-indigo-400/25 bg-indigo-400/[0.04]"
          : "border-white/10 bg-white/[0.02]",
      )}
    >
      <p
        className={cn(
          "text-[11.5px] font-semibold uppercase tracking-[0.18em]",
          tone === "visitors" ? "text-indigo-300" : "text-gray-700",
        )}
      >
        {eyebrow}
      </p>
      <h2 className="mt-1.5 text-2xl font-semibold text-white tracking-tight">{title}</h2>
      <p className="mt-2 text-sm text-gray-800 max-w-prose">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Section scaffolding                                                         */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  title,
  recipe,
  children,
}: {
  id: string;
  title: string;
  recipe?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-medium text-gray-1000">{title}</h2>
        {recipe ? <p className="text-[13px] text-gray-800">{recipe}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-4 py-3 border-t border-white/5 first:border-t-0">
      <div className="text-[12.5px] text-gray-800 tabular">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function ChatThreadSection() {
  return (
    <Section
      id="chat-thread"
      title="Chat thread"
      recipe="Active conversation: user bubble, tool trace accordions, thought disclosures, search rows, prose, reactions, suggestions, bottom composer."
    >
      <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-[rgb(12,12,12)] shadow-pop">
        <div className="h-[780px]">
          <DimensionChatThread />
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

const GRAY_STOPS = [
  "0",
  "25",
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "850",
  "900",
  "950",
  "1000",
] as const;

const PURPLE_STOPS = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;

function TokensSection() {
  return (
    <Section
      id="tokens"
      title="Tokens — color"
      recipe="Dimension's exact 16-stop gray and 11-stop purple scales. Body bg is rgb(12,12,12)."
    >
      <Swatches name="--gray-N" scale="gray" stops={GRAY_STOPS} />
      <Swatches name="--purple-N" scale="purple" stops={PURPLE_STOPS} />
    </Section>
  );
}

function Swatches<T extends string>({
  name,
  scale,
  stops,
}: {
  name: string;
  scale: "gray" | "purple";
  stops: ReadonlyArray<T>;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[12.5px] text-gray-800 tabular">{name}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
        {stops.map((s) => (
          <div key={s} className="space-y-1">
            <div
              className="h-12 rounded-md border border-white/5"
              style={{ backgroundColor: `rgb(var(--${scale}-${s}))` }}
            />
            <div className="text-[11px] text-gray-800 tabular">{s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

function ButtonSection() {
  return (
    <Section
      id="button"
      title="Button"
      recipe="One pill shape. Variants change fill + inset glow only. apps/web/src/components/ui/button.tsx"
    >
      <Row label="primary · lg">
        <Button variant="primary" size="lg">
          Create Workflow
        </Button>
        <Button variant="primary" size="lg" leading={<Sparkles size={14} />}>
          Learn
        </Button>
        <Button variant="primary" size="lg" disabled>
          Disabled
        </Button>
        <Button variant="primary" size="lg" loading>
          Loading
        </Button>
      </Row>

      <Row label="primary · sizes">
        <Button variant="primary" size="sm">
          sm
        </Button>
        <Button variant="primary" size="md">
          md
        </Button>
        <Button variant="primary" size="mdPlus">
          mdPlus
        </Button>
        <Button variant="primary" size="lg">
          lg
        </Button>
      </Row>

      <Row label="white">
        <Button variant="white" size="lg">
          Upgrade Plan
        </Button>
        <Button variant="white" size="mdPlus" leading={<Plus size={14} />}>
          New chat
        </Button>
        <Button variant="white" size="lg" disabled>
          Disabled
        </Button>
      </Row>

      <Row label="destructive">
        <Button variant="destructive" size="lg" leading={<LogOut size={14} />}>
          Sign out
        </Button>
        <Button variant="destructive" size="mdPlus">
          Delete account
        </Button>
      </Row>

      <Row label="ghost">
        <Button variant="ghost" size="mdPlus">
          Manage
        </Button>
        <Button variant="ghost" size="mdPlus">
          Connect
        </Button>
        <Button variant="ghost" size="mdPlus" disabled>
          Coming Soon
        </Button>
        <Button variant="ghost" size="md">
          Share
        </Button>
      </Row>

      <Row label="send">
        <Button variant="send" size="md" aria-label="Send">
          <ArrowUp size={16} />
        </Button>
        <Button variant="send" size="mdPlus" aria-label="Send">
          <ArrowUp size={16} />
        </Button>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* IconButton                                                                  */
/* -------------------------------------------------------------------------- */

function IconButtonSection() {
  return (
    <Section
      id="icon-button"
      title="IconButton"
      recipe="Square rounded-lg, 28 or 32. Quiet ghost styling. Press scale-[0.96]."
    >
      <Row label="size sm">
        <IconButton label="Search" size="sm">
          <Search size={14} />
        </IconButton>
        <IconButton label="Add" size="sm">
          <Plus size={14} />
        </IconButton>
        <IconButton label="Confirm" size="sm" disabled>
          <Check size={14} />
        </IconButton>
      </Row>
      <Row label="size md">
        <IconButton label="Search" size="md">
          <Search size={16} />
        </IconButton>
        <IconButton label="Microphone" size="md">
          <Mic size={16} />
        </IconButton>
        <IconButton label="Add" size="md">
          <Plus size={16} />
        </IconButton>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

function InputSection() {
  return (
    <Section
      id="input"
      title="Input"
      recipe="gray-50/50 fill ramps to opaque on focus. Border gray-100 → 200 → 300. rounded-lg or rounded-full (search)."
    >
      <Row label="default">
        <div className="w-80">
          <Input placeholder="Untitled skill" />
        </div>
      </Row>
      <Row label="filled">
        <div className="w-80">
          <Input defaultValue="Wake me up gently" />
        </div>
      </Row>
      <Row label="disabled">
        <div className="w-80">
          <Input defaultValue="Read only" disabled />
        </div>
      </Row>
      <Row label="search">
        <div className="w-80">
          <Input
            variant="search"
            placeholder="Search integrations"
            leading={<Search size={14} />}
          />
        </div>
      </Row>
      <Row label="with trailing">
        <div className="w-80">
          <Input placeholder="Press ⌘K" trailing={<Kbd>⌘K</Kbd>} />
        </div>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Textarea                                                                    */
/* -------------------------------------------------------------------------- */

function TextareaSection() {
  return (
    <Section
      id="textarea"
      title="Textarea"
      recipe="card: same recipe as Input + min-h, resize-none. inline: bg-transparent border-0 p-0 (composer)."
    >
      <Row label="card">
        <div className="w-96">
          <Textarea placeholder="Background — what does Alfred need to know?" />
        </div>
      </Row>
      <Row label="card · filled">
        <div className="w-96">
          <Textarea
            defaultValue={
              "Alfred should not action anything before 7am. Triage email aggressively — only Slack me for items that need a same-day reply."
            }
          />
        </div>
      </Row>
      <Row label="inline (heading)">
        <div className="w-96">
          <Textarea
            variant="inline"
            placeholder="Untitled skill"
            rows={1}
            className="text-2xl font-medium"
          />
        </div>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Switch                                                                      */
/* -------------------------------------------------------------------------- */

function SwitchSection() {
  return (
    <Section
      id="switch"
      title="Switch"
      recipe="44×24 track. Off gray-100, on purple-400. Thumb is a 20px white disc with subtle shadow."
    >
      <Row label="uncontrolled">
        <Switch defaultChecked={false} />
        <Switch defaultChecked />
      </Row>
      <Row label="controlled">
        <ControlledSwitchDemo />
      </Row>
      <Row label="disabled">
        <Switch defaultChecked={false} disabled />
        <Switch defaultChecked disabled />
      </Row>
      <Row label="form row">
        <div className="w-96 flex items-center justify-between rounded-2xl border border-white/5 px-3 py-2.5">
          <div className="space-y-0.5">
            <div className="text-sm text-gray-950">Auto-approve replies</div>
            <div className="text-[12.5px] text-gray-800">
              Drafts will be sent without confirmation.
            </div>
          </div>
          <Switch defaultChecked />
        </div>
      </Row>
    </Section>
  );
}

function ControlledSwitchDemo() {
  const [on, setOn] = useState(true);
  return (
    <div className="flex items-center gap-3">
      <Switch checked={on} onCheckedChange={setOn} />
      <span className="text-[12.5px] text-gray-800 tabular">checked = {on ? "true" : "false"}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

function TabsSection() {
  const [underline, setUnderline] = useState<"learn" | "history">("learn");
  const [segmented, setSegmented] = useState<"chat" | "todos" | "agents">("chat");
  const [pill, setPill] = useState<"gmail" | "slack" | "imessage">("gmail");

  return (
    <Section
      id="tabs"
      title="Tabs"
      recipe="3 variants — underline (skill editor), segmented (rail mode), pill (settings)."
    >
      <Row label="underline">
        <Tabs
          variant="underline"
          value={underline}
          onValueChange={setUnderline}
          items={[
            { value: "learn", label: "Learn" },
            { value: "history", label: "History", icon: <HistoryIcon size={14} /> },
          ]}
        />
      </Row>
      <Row label="segmented">
        <Tabs
          variant="segmented"
          value={segmented}
          onValueChange={setSegmented}
          items={[
            { value: "chat", label: "Chat" },
            { value: "todos", label: "Todos" },
            { value: "agents", label: "Agents" },
          ]}
        />
      </Row>
      <Row label="pill">
        <Tabs
          variant="pill"
          value={pill}
          onValueChange={setPill}
          items={[
            { value: "gmail", label: "Gmail", icon: <Mail size={14} /> },
            { value: "slack", label: "Slack", icon: <Bell size={14} /> },
            { value: "imessage", label: "iMessage", icon: <Home size={14} /> },
          ]}
        />
      </Row>
    </Section>
  );
}

function QuickAccessRailSection() {
  return (
    <Section
      id="quick-access-rail"
      title="Quick Access Rail"
      recipe="Weather-backed right rail: weather header, icon tablist, add-todo row, suggestions, and Morning Briefing bottom action."
    >
      <div className="h-[640px] w-[348px]">
        <QuickAccessRail />
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

function CardSection() {
  return (
    <Section
      id="card"
      title="Card"
      recipe="rounded-2xl, transparent at rest, hover/focus fill #181818. Use `interactive` when the card itself is clickable."
    >
      <Row label="static">
        <Card className="max-w-md">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg frost-icon-tile grid place-items-center">
              <Mail size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-1000">Gmail</div>
              <div className="text-[12.5px] text-gray-800 truncate">
                Read inbox + draft replies on your behalf.
              </div>
            </div>
          </div>
        </Card>
      </Row>
      <Row label="interactive">
        <Card interactive tabIndex={0} className="max-w-md">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg frost-icon-tile grid place-items-center">
              <Bell size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-1000">Morning briefing</div>
              <div className="text-[12.5px] text-gray-800 truncate">
                Daily summary of your inbox before 7am.
              </div>
            </div>
            <Button variant="ghost" size="md">
              Manage
            </Button>
          </div>
        </Card>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* FrostPanel                                                                  */
/* -------------------------------------------------------------------------- */

function FrostPanelSection() {
  return (
    <Section
      id="frost-panel"
      title="FrostPanel"
      recipe="Wraps the .frost-panel CSS class. Used for code blocks, tables, structured agent output."
    >
      <Row label="default">
        <FrostPanel className="max-w-md">
          <div className="space-y-2 text-sm text-gray-950">
            <div className="text-[12.5px] text-gray-800">Tool · gmail.search</div>
            <div className="font-mono text-[12.5px] text-gray-1000">
              from:notifications@github.com newer_than:1d
            </div>
            <div className="text-[12.5px] text-gray-800">→ 4 results</div>
          </div>
        </FrostPanel>
      </Row>
      <Row label="with divider rows">
        <FrostPanel className="max-w-md p-1">
          <div className="divide-y divide-white/5">
            <div className="px-3 py-2.5 text-sm text-gray-950">Send a draft to Pooja</div>
            <div className="px-3 py-2.5 text-sm text-gray-950">Reply to Patrick about Friday</div>
            <div className="px-3 py-2.5 text-sm text-gray-950">Archive the 3 marketing threads</div>
          </div>
        </FrostPanel>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Avatar                                                                      */
/* -------------------------------------------------------------------------- */

function AvatarSection() {
  return (
    <Section
      id="avatar"
      title="Avatar"
      recipe="Radial-gradient disc. Optional initial. Sizes sm (16) / md (28) / lg (36)."
    >
      <Row label="pseudo">
        <Avatar size="sm" />
        <Avatar size="md" />
        <Avatar size="lg" />
      </Row>
      <Row label="initial">
        <Avatar size="sm" initial="y" />
        <Avatar size="md" initial="y" />
        <Avatar size="lg" initial="y" />
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Kbd                                                                         */
/* -------------------------------------------------------------------------- */

function KbdSection() {
  return (
    <Section
      id="kbd"
      title="Kbd"
      recipe="11px tabular chip with hairline border. Sits next to nav rows + primary actions."
    >
      <Row label="single">
        <Kbd>⌘K</Kbd>
        <Kbd>⇧O</Kbd>
        <Kbd>↵</Kbd>
        <Kbd>Esc</Kbd>
      </Row>
      <Row label="combo">
        <Kbd>⌘↵</Kbd>
        <Kbd>⌥⇧K</Kbd>
      </Row>
      <Row label="in context">
        <Button variant="primary" size="md" trailing={<Kbd>⌘↵</Kbd>}>
          Learn
        </Button>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* StatusDot                                                                   */
/* -------------------------------------------------------------------------- */

function StatusDotSection() {
  return (
    <Section
      id="status-dot"
      title="StatusDot"
      recipe="Glowing dot. Tones emerald/amber/red/muted. Sizes sm (1.5) / md (2.5)."
    >
      <Row label="tones · md">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-gray-800">
          <StatusDot tone="emerald" /> connected
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-gray-800">
          <StatusDot tone="amber" /> pending
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-gray-800">
          <StatusDot tone="red" /> error
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-gray-800">
          <StatusDot tone="muted" /> idle
        </span>
      </Row>
      <Row label="tones · sm">
        <StatusDot tone="emerald" size="sm" />
        <StatusDot tone="amber" size="sm" />
        <StatusDot tone="red" size="sm" />
        <StatusDot tone="muted" size="sm" />
      </Row>
      <Row label="in context">
        <span className="inline-flex h-7 items-center gap-2 px-3 rounded-full frost-border bg-white/[0.04] text-[13px] text-gray-950">
          <StatusDot tone="emerald" />
          Auto
        </span>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* frost-border showcase                                                       */
/* -------------------------------------------------------------------------- */

function FrostBorderSection() {
  return (
    <Section
      id="frost-border"
      title="frost-border"
      recipe="1px gradient hairline via ::before. Parameterized by --frost-strength + --frost-border-strength. Most-reused Dimension pattern."
    >
      <Row label="default">
        <div className="frost-border h-10 px-4 rounded-full inline-flex items-center bg-[rgb(var(--purple-300))]">
          strength 1 / 1
        </div>
      </Row>
      <Row label="strong">
        <div
          className="frost-border h-10 px-4 rounded-full inline-flex items-center bg-white text-black"
          style={{
            // bumped variant — matches the Upgrade Plan white pill
            ["--frost-strength" as never]: "0.8",
            ["--frost-border-strength" as never]: "3",
          }}
        >
          strength 0.8 / 3
        </div>
      </Row>
      <Row label="subtle">
        <div
          className="frost-border h-10 px-4 rounded-full inline-flex items-center bg-[rgb(var(--gray-50))] text-gray-950"
          style={{
            ["--frost-strength" as never]: "1",
            ["--frost-border-strength" as never]: "0.3",
          }}
        >
          strength 1 / 0.3
        </div>
      </Row>
      <Row label="panel">
        <div className="frost-border rounded-2xl p-4 bg-[rgb(28,28,28)]/50 backdrop-blur-sm text-sm text-gray-950 min-w-[220px]">
          Frost panel: used for code blocks and structured agent output. Holds a hairline plus an
          inset glow.
        </div>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Command palette                                                             */
/* -------------------------------------------------------------------------- */

function CommandPaletteSection() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Section
      id="command-palette"
      title="Command palette"
      recipe="cmdk + Radix Dialog. ⌘K from anywhere in the app opens this from the AppShell. Result rows: h-11 rounded-md px-3 + leading icon tile + trailing ↵ on the selected row."
    >
      <Row label="trigger">
        <Button variant="white" size="md" onClick={() => setOpen(true)}>
          <Search size={14} className="mr-1.5" />
          Open palette
          <Kbd className="ml-2">⌘K</Kbd>
        </Button>
        {picked ? (
          <span className="text-[12.5px] text-gray-800 tabular">
            Last pick: <span className="text-gray-950">{picked}</span>
          </span>
        ) : null}
      </Row>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        placeholder="Search demo…"
        ariaTitle="Styleguide command palette"
        footer={<CommandPalette.Legend />}
      >
        <CommandPalette.Group heading="Actions">
          <CommandPalette.Item
            value="action:new-chat"
            keywords={["new", "chat", "compose"]}
            onSelect={() => {
              setPicked("New chat");
              setOpen(false);
            }}
            icon={Plus}
            shortcut="↵"
          >
            New chat
          </CommandPalette.Item>
          <CommandPalette.Item
            value="action:cycle-theme"
            onSelect={() => {
              setPicked("Cycle theme");
              setOpen(false);
            }}
            icon={MoonStar}
          >
            Cycle theme
          </CommandPalette.Item>
          <CommandPalette.Item
            value="action:sign-out"
            onSelect={() => {
              setPicked("Sign out");
              setOpen(false);
            }}
            icon={LogOut}
          >
            Sign out
          </CommandPalette.Item>
        </CommandPalette.Group>
        <CommandPalette.Group heading="Navigate">
          <CommandPalette.Item
            value="nav:/integrations"
            onSelect={() => {
              setPicked("/integrations");
              setOpen(false);
            }}
            icon={Plug}
          >
            Integrations
          </CommandPalette.Item>
          <CommandPalette.Item
            value="nav:/workflows"
            onSelect={() => {
              setPicked("/workflows");
              setOpen(false);
            }}
            icon={Workflow}
          >
            Workflows
          </CommandPalette.Item>
          <CommandPalette.Item
            value="nav:/skills"
            onSelect={() => {
              setPicked("/skills");
              setOpen(false);
            }}
            icon={Sparkles}
          >
            Skills
          </CommandPalette.Item>
          <CommandPalette.Item
            value="nav:/library"
            onSelect={() => {
              setPicked("/library");
              setOpen(false);
            }}
            icon={Archive}
          >
            Library
          </CommandPalette.Item>
          <CommandPalette.Item
            value="nav:/settings"
            onSelect={() => {
              setPicked("/settings");
              setOpen(false);
            }}
            icon={SettingsIcon}
          >
            Settings
          </CommandPalette.Item>
        </CommandPalette.Group>
      </CommandPalette>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Typography                                                                  */
/* -------------------------------------------------------------------------- */

function TypographySection() {
  return (
    <Section
      id="typography"
      title="Display typography"
      recipe="Every route title uses the white→white/60 gradient text. Active tabs use a lavender variant."
    >
      <Row label="display">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Good morning, Yash
        </h1>
      </Row>
      <Row label="lavender">
        <h1 className="heading-display-lavender text-2xl font-medium">Learn (active tab)</h1>
      </Row>
      <Row label="body">
        <p className="text-sm text-gray-950 max-w-prose">
          Body copy at 14/20.{" "}
          <strong className="text-gray-1000 font-semibold">
            Bold prose ramps to gray-1000 (white).
          </strong>{" "}
          Default body color is gray-950 (rgb 237,237,237).
        </p>
      </Row>
      <Row label="muted">
        <p className="text-[13px] text-gray-800">
          Muted text uses gray-800 (rgb 160,160,160). The 13px variant is the workhorse for chips
          and meta.
        </p>
      </Row>
    </Section>
  );
}

/* ========================================================================== */
/* Visitors half — landing-grammar primitives. Wrap in LandingBackground so   */
/* every preview reads on the new #0a0a0a canvas with its faint grid.         */
/* ========================================================================== */

function VisitorsHalf() {
  return (
    <div className="space-y-16">
      <HalfBanner
        tone="visitors"
        eyebrow="After"
        title="Visitors revamp"
        body="The marketing-landing grammar: Open Runde, tighter negative tracking, indigo/violet accents, frost-glass buttons, frost-pill nav, device-bezel mockups, scroll-triggered fades. Everything here lives in apps/web/src/components/landing/."
      />

      <VisitorsTokensSection />
      <VisitorsHeroTypographySection />
      <FrostButtonSection />
      <EyebrowChipSection />
      <TopAnnouncementSection />
      <FloatingPillNavSection />
      <TabPillSection />
      <AuroraGlowSection />
      <DeviceBezelSection />
      <BenefitsRowSection />
      <FeatureCardSection />
      <OperationalPillSection />
      <FadeInOnScrollSection />
      <HeroShowcaseSection />
      <MorningBriefingSection />
      <LandingCtaSectionPreview />
      <LandingFooterPreview />
    </div>
  );
}

/**
 * Shared canvas wrapper for visitors-half previews — matches the actual
 * landing background (#0a0a0a + 80px grid + Open Runde) so primitives like
 * FrostButton read identically to the production page.
 */
function VisitorsCanvas({
  children,
  className,
  height,
}: {
  children: ReactNode;
  className?: string;
  height?: string;
}) {
  return (
    <LandingBackground className={cn("rounded-2xl overflow-hidden", height, className)}>
      <div className="p-6">{children}</div>
    </LandingBackground>
  );
}

/* ----------------------------- Tokens ----------------------------- */

function VisitorsTokensSection() {
  return (
    <Section
      id="visitors-tokens"
      title="Tokens — visitors palette"
      recipe="Background is #0a0a0a (slightly bluer than Dimension's rgb(12,12,12)). Accents lean indigo/violet for ambient warmth, with emerald/amber as status colors. Type stack locks Open Runde at the landing root."
    >
      <Row label="canvas">
        <div className="flex items-center gap-3">
          <div
            className="h-16 w-24 rounded-lg border border-white/10"
            style={{ background: "#0a0a0a" }}
          />
          <div className="text-[12.5px] text-gray-800 tabular">
            #0a0a0a · faint 80px grid · top vignette
          </div>
        </div>
      </Row>
      <Row label="accents">
        {[
          { label: "indigo-300", className: "bg-indigo-300" },
          { label: "indigo-400", className: "bg-indigo-400" },
          { label: "violet-400", className: "bg-violet-400" },
          { label: "violet-500", className: "bg-violet-500" },
          { label: "fuchsia-500", className: "bg-fuchsia-500" },
          { label: "emerald-300", className: "bg-emerald-300" },
          { label: "amber-300", className: "bg-amber-300" },
          { label: "rose-300", className: "bg-rose-300" },
        ].map((swatch) => (
          <div key={swatch.label} className="flex flex-col items-center gap-1">
            <div className={cn("h-10 w-12 rounded-md border border-white/10", swatch.className)} />
            <div className="text-[11px] text-gray-800 tabular">{swatch.label}</div>
          </div>
        ))}
      </Row>
      <Row label="neutral ramp">
        {[
          { label: "neutral-300", className: "bg-neutral-300" },
          { label: "neutral-400", className: "bg-neutral-400" },
          { label: "neutral-500", className: "bg-neutral-500" },
          { label: "neutral-600", className: "bg-neutral-600" },
          { label: "neutral-700", className: "bg-neutral-700" },
          { label: "neutral-800", className: "bg-neutral-800" },
          { label: "neutral-900", className: "bg-neutral-900" },
        ].map((swatch) => (
          <div key={swatch.label} className="flex flex-col items-center gap-1">
            <div className={cn("h-10 w-12 rounded-md border border-white/10", swatch.className)} />
            <div className="text-[11px] text-gray-800 tabular">{swatch.label}</div>
          </div>
        ))}
      </Row>
      <Row label="font stack">
        <code className="font-mono text-[12px] text-emerald-300">
          "Open Runde", Inter, ui-sans-serif, system-ui
        </code>
      </Row>
      <Row label="tracking">
        <code className="font-mono text-[12px] text-gray-800">
          body tracking-[-0.012em] · headlines tracking-[-0.045em]
        </code>
      </Row>
    </Section>
  );
}

/* ----------------------------- Hero typography ----------------------------- */

function VisitorsHeroTypographySection() {
  return (
    <Section
      id="visitors-hero-typography"
      title="Hero typography"
      recipe="Three sizes carry the landing: 6xl hero headline, 4xl/5xl section heading, 15–18px sub. All semibold, white, with negative tracking to bring letters closer."
    >
      <VisitorsCanvas>
        <div className="space-y-5 text-center">
          <h1
            className={cn(
              "mx-auto max-w-3xl text-balance font-semibold text-white",
              "text-[44px] leading-[1.05] tracking-[-0.045em] sm:text-5xl lg:text-6xl",
            )}
          >
            The AI coworker that never sleeps.
          </h1>
          <p className="mx-auto max-w-2xl text-balance text-[16px] font-medium leading-[1.5] tracking-[-0.018em] text-neutral-400 sm:text-[18px]">
            Alfred connects to your email, calendar, and tools to triage your inbox, brief you each
            morning, and prepare you for every meeting, quietly, in the background.
          </p>
          <p className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            Get Started
          </p>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- FrostButton ----------------------------- */

function FrostButtonSection() {
  return (
    <Section
      id="frost-button"
      title="FrostButton"
      recipe="Frost-border pill with a radial top-left specular and a hover after-overlay. Dark tone (default) is translucent white-on-black; light tone is bright fill with dark text (Dimension's original CTA recipe)."
    >
      <VisitorsCanvas>
        <div className="space-y-6">
          <Row label="dark · sizes">
            <FrostButton tone="dark" size="sm">
              Get Started
            </FrostButton>
            <FrostButton tone="dark" size="md">
              Get Started
            </FrostButton>
            <FrostButton tone="dark" size="lg">
              Get Started
              <ArrowRight className="size-4" />
            </FrostButton>
          </Row>
          <Row label="light · sizes">
            <FrostButton tone="light" size="sm">
              Get Started
            </FrostButton>
            <FrostButton tone="light" size="md">
              Get Started
            </FrostButton>
            <FrostButton tone="light" size="lg">
              Get Started
              <ArrowRight className="size-4" />
            </FrostButton>
          </Row>
          <Row label="disabled">
            <FrostButton tone="dark" size="md" disabled>
              Get Started
            </FrostButton>
            <FrostButton tone="light" size="md" disabled>
              Get Started
            </FrostButton>
          </Row>
          <Row label="loading">
            <FrostButton tone="dark" size="sm" loading>
              Get Started
            </FrostButton>
            <FrostButton tone="dark" size="md" loading>
              Get Started
            </FrostButton>
            <FrostButton tone="dark" size="lg" loading>
              Get Started
              <ArrowRight className="size-4" />
            </FrostButton>
            <FrostButton tone="light" size="md" loading>
              Get Started
            </FrostButton>
          </Row>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- EyebrowChip ----------------------------- */

function EyebrowChipSection() {
  return (
    <Section
      id="visitors-eyebrow-chip"
      title="EyebrowChip"
      recipe="Small bordered pill above hero headlines. Four accents — neutral, indigo, emerald, amber — paired with a leading icon or a status dot."
    >
      <VisitorsCanvas>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <EyebrowChip icon={<Sparkles className="size-3.5" strokeWidth={2} />} accent="indigo">
            Personal AI assistant
          </EyebrowChip>
          <EyebrowChip icon={<DemoStatusDot tone="emerald" />} accent="emerald">
            Server online
          </EyebrowChip>
          <EyebrowChip icon={<DemoStatusDot tone="amber" />} accent="amber">
            Server unreachable
          </EyebrowChip>
          <EyebrowChip icon={<DemoStatusDot tone="neutral" />} accent="neutral">
            Checking server…
          </EyebrowChip>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

function EyebrowChip({
  children,
  icon,
  accent = "neutral",
}: {
  children: ReactNode;
  icon?: ReactNode;
  accent?: "neutral" | "emerald" | "indigo" | "amber";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        "text-[12px] font-medium tracking-tight",
        "border",
        accent === "emerald" && "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300",
        accent === "indigo" && "border-indigo-400/25 bg-indigo-400/[0.07] text-indigo-200",
        accent === "amber" && "border-amber-400/25 bg-amber-400/[0.07] text-amber-200",
        accent === "neutral" && "border-neutral-800 bg-neutral-900/60 text-neutral-300",
      )}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}

function DemoStatusDot({ tone }: { tone: "emerald" | "amber" | "neutral" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 rounded-full",
        tone === "emerald" && "bg-emerald-400",
        tone === "amber" && "bg-amber-400",
        tone === "neutral" && "bg-neutral-400",
      )}
    />
  );
}

/* ----------------------------- TopAnnouncement ----------------------------- */

function TopAnnouncementSection() {
  return (
    <Section
      id="visitors-top-announcement"
      title="TopAnnouncement"
      recipe="Pinned at top of page in production (fixed positioning). Previewed inline here. Blurred glass pill with a status dot + arrow that translates on hover."
    >
      <VisitorsCanvas>
        <div className="relative flex flex-col items-center gap-4">
          {/* Inline simulation — strip the `fixed` positioning so the pill
              renders within the styleguide column. */}
          <a
            href="#"
            className={cn(
              "group relative flex items-center gap-2 sm:gap-2.5",
              "rounded-full px-3 py-1.5 sm:px-3.5 text-[12px] sm:text-[12.5px]",
              "text-white/85 hover:text-white",
              "before:absolute before:inset-0 before:-z-10 before:rounded-full",
              "before:bg-black/30 before:backdrop-blur-md hover:before:bg-black/40",
              "ring-1 ring-inset ring-white/10 hover:ring-white/20",
              "transition-all duration-200",
            )}
          >
            <span aria-hidden className="size-1 shrink-0 rounded-full bg-amber-200/70" />
            <span className="whitespace-nowrap">Now in private beta — request access</span>
            <span
              aria-hidden
              className="text-white/55 transition-transform group-hover:translate-x-0.5 group-hover:text-white/80"
            >
              →
            </span>
          </a>
          <p className="text-[11px] text-gray-700 tabular">
            See <code className="font-mono text-emerald-300">TopAnnouncement</code> in
            components/landing/top-announcement.tsx — production renders fixed at top:5.
          </p>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- FloatingPillNav ----------------------------- */

function FloatingPillNavSection() {
  return (
    <Section
      id="visitors-floating-nav"
      title="FloatingPillNav"
      recipe="Bottom-pinned in production via `fixed`. Previewed inline here as a relative pill so it docks within the styleguide column."
    >
      <VisitorsCanvas>
        <div className="flex items-center justify-center py-8">
          {/* Inline simulation — mirrors FloatingPillNav's structure but
              strips the fixed positioning that would otherwise pin it to
              the viewport across both halves of the styleguide. */}
          <nav
            aria-label="Primary"
            className={cn(
              "relative h-fit w-fit",
              "rounded-full p-3 flex items-center justify-between gap-4",
              "before:absolute before:left-0 before:top-0 before:-z-10",
              "before:size-full before:rounded-full",
              "before:bg-black/40 before:backdrop-blur-lg",
            )}
          >
            <div className="ml-2 flex items-center gap-2">
              <a href="#" className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-white text-[10px] font-bold text-black">
                  A
                </span>
                <span className="text-sm font-semibold text-white">Alfred</span>
              </a>
            </div>
            <div aria-hidden className="h-6 w-px shrink-0 bg-white/10" />
            <div className="flex items-center gap-0 text-sm text-white">
              <a
                href="#"
                className="rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-neutral-300 transition-colors hover:bg-white/5 hover:text-white"
              >
                Why Alfred
              </a>
              <a
                href="#"
                className="rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-neutral-300 transition-colors hover:bg-white/5 hover:text-white"
              >
                Pricing
              </a>
            </div>
            <div className="shrink-0">
              <FrostButton tone="light" size="sm">
                Get Started
              </FrostButton>
            </div>
          </nav>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- TabPill ----------------------------- */

function TabPillSection() {
  const [tab, setTab] = useState<"briefing" | "inbox" | "meetings">("briefing");
  return (
    <Section
      id="visitors-tab-pill"
      title="TabPill"
      recipe="Dark frosted segmented pill with a sliding indigo→violet→fuchsia indicator. Sits above the hero device bezel; auto-cycles in HeroShowcase."
    >
      <VisitorsCanvas>
        <div className="relative flex justify-center py-4">
          <AuroraGlow intensity="subtle" />
          <TabPill
            value={tab}
            onChange={setTab}
            options={[
              { value: "briefing", label: "Briefing" },
              { value: "inbox", label: "Inbox" },
              { value: "meetings", label: "Meeting Prep" },
            ]}
          />
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- AuroraGlow ----------------------------- */

function AuroraGlowSection() {
  return (
    <Section
      id="visitors-aurora-glow"
      title="AuroraGlow"
      recipe="Two stacked radial gradients — wide indigo halo + tighter violet hot-spot. Sits behind the device bezel to make the mockup feel lit from above. intensity: default | subtle."
    >
      <VisitorsCanvas>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="relative h-48 rounded-2xl border border-white/10 bg-black/40">
            <AuroraGlow intensity="default" />
            <div className="absolute inset-x-0 bottom-3 text-center text-[12.5px] text-gray-800 tabular">
              intensity="default"
            </div>
          </div>
          <div className="relative h-48 rounded-2xl border border-white/10 bg-black/40">
            <AuroraGlow intensity="subtle" />
            <div className="absolute inset-x-0 bottom-3 text-center text-[12.5px] text-gray-800 tabular">
              intensity="subtle"
            </div>
          </div>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- DeviceBezel ----------------------------- */

function DeviceBezelSection() {
  return (
    <Section
      id="visitors-device-bezel"
      title="DeviceBezel"
      recipe="Triple-nested rounded bezel (3rem → 2.5rem → 2rem) with two layered borders + a vertical gradient fill. Frames any mockup so it reads as a physical screen."
    >
      <VisitorsCanvas>
        <div className="relative">
          <AuroraGlow intensity="subtle" />
          <DeviceBezel>
            <div className="grid h-48 place-items-center bg-neutral-950 text-[13px] text-neutral-500">
              children render here, edge-to-edge
            </div>
          </DeviceBezel>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- BenefitsRow ----------------------------- */

function BenefitsRowSection() {
  return (
    <Section
      id="visitors-benefits-row"
      title="BenefitsRow"
      recipe="3-up grid — small indigo-tinted icon tile + bold lead + muted tagline. Fades each column in 80ms apart on scroll."
    >
      <VisitorsCanvas>
        <BenefitsRow />
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- FeatureCard ----------------------------- */

function FeatureCardSection() {
  return (
    <Section
      id="visitors-feature-card"
      title="Feature card"
      recipe="Rounded-[20px] card with a tone-tinted icon tile, colored eyebrow, big title, body, three checkmark bullets, and a stylized mockup. Tones: indigo / peach / rose / emerald."
    >
      <VisitorsCanvas>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FeatureCardDemo
            tone="indigo"
            eyebrow="Inbox triage"
            title="Drafts replies in your tone."
            body="Triages every overnight thread, archives the noise, and drafts replies only for the threads that actually want one."
            bullets={[
              "Learns your tone from your sent mail",
              "Archives newsletters + receipts on its own",
              "Marks the four threads worth your morning",
            ]}
          />
          <FeatureCardDemo
            tone="emerald"
            eyebrow="Anywhere"
            title="Talk to it from any tool."
            body="Chat with Alfred from the web, your phone, the terminal, or any iMessage thread — same memory, same context, every time."
            bullets={[
              "iMessage, Slack, browser, and CLI",
              "Persistent memory across sessions",
              "Knows what you asked yesterday",
            ]}
          />
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

function FeatureCardDemo({
  tone,
  eyebrow,
  title,
  body,
  bullets,
}: {
  tone: "indigo" | "peach" | "rose" | "emerald";
  eyebrow: string;
  title: string;
  body: string;
  bullets: ReadonlyArray<string>;
}) {
  const TONE: Record<typeof tone, { text: string; bg: string; ring: string }> = {
    indigo: { text: "text-indigo-300", bg: "bg-indigo-400/[0.08]", ring: "ring-indigo-400/20" },
    peach: { text: "text-orange-300", bg: "bg-orange-400/[0.08]", ring: "ring-orange-400/20" },
    rose: { text: "text-rose-300", bg: "bg-rose-400/[0.08]", ring: "ring-rose-400/20" },
    emerald: { text: "text-emerald-300", bg: "bg-emerald-400/[0.08]", ring: "ring-emerald-400/20" },
  };
  const t = TONE[tone];
  return (
    <article
      className={cn(
        "group relative isolate flex h-full flex-col overflow-hidden rounded-[20px]",
        "border border-neutral-800/80 bg-neutral-950/60",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
      )}
    >
      <div className="flex flex-col gap-3 p-7 sm:p-8">
        <span
          className={cn(
            "grid size-9 place-items-center rounded-xl ring-1 ring-inset",
            t.bg,
            t.ring,
          )}
        >
          <Sparkles className={cn("size-4", t.text)} strokeWidth={2} />
        </span>
        <p className={cn("text-[13px] font-semibold tracking-tight", t.text)}>{eyebrow}</p>
        <h3 className="max-w-[22ch] text-balance text-[22px] font-semibold leading-[1.18] tracking-[-0.035em] text-white sm:text-[24px]">
          {title}
        </h3>
        <p className="max-w-[36ch] text-[14.5px] leading-[1.55] tracking-[-0.012em] text-neutral-400">
          {body}
        </p>
        <ul className="mt-2 space-y-1.5">
          {bullets.map((b) => (
            <li
              key={b}
              className="flex items-start gap-2 text-[13.5px] leading-[1.5] text-neutral-300"
            >
              <Check className={cn("mt-[3px] size-3.5 shrink-0", t.text)} strokeWidth={2.6} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

/* ----------------------------- Operational pill ----------------------------- */

function OperationalPillSection() {
  return (
    <Section
      id="visitors-operational-pill"
      title="Operational pill"
      recipe="Footer status indicator — green ping-dot when API is reachable, amber when degraded. No separate status page; the dot is the affordance."
    >
      <VisitorsCanvas>
        <div className="flex flex-wrap gap-6">
          <span className="inline-flex w-fit items-center gap-2 text-[13px] font-medium text-neutral-400">
            <span className="relative grid size-2 place-items-center" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative size-1.5 rounded-full bg-emerald-400" />
            </span>
            Operational
          </span>
          <span className="inline-flex w-fit items-center gap-2 text-[13px] font-medium text-amber-400/85">
            <span className="relative grid size-2 place-items-center" aria-hidden>
              <span className="relative size-1.5 rounded-full bg-amber-400" />
            </span>
            Degraded
          </span>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- FadeInOnScroll ----------------------------- */

function FadeInOnScrollSection() {
  const [key, setKey] = useState(0);
  return (
    <Section
      id="visitors-fade-in"
      title="FadeInOnScroll"
      recipe="IntersectionObserver-driven wrapper — children start translated/blurred and fade in on first viewport entry. Stagger with `delay` for sequenced reveals."
    >
      <VisitorsCanvas>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setKey((k) => k + 1)}
            className="rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/15"
          >
            Replay reveal
          </button>
          <div key={key} className="space-y-3">
            <FadeInOnScroll delay={0}>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-neutral-200">
                Row 1 · delay 0ms
              </div>
            </FadeInOnScroll>
            <FadeInOnScroll delay={80}>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-neutral-200">
                Row 2 · delay 80ms
              </div>
            </FadeInOnScroll>
            <FadeInOnScroll delay={160}>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-neutral-200">
                Row 3 · delay 160ms
              </div>
            </FadeInOnScroll>
          </div>
        </div>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- HeroShowcase ----------------------------- */

function HeroShowcaseSection() {
  return (
    <Section
      id="visitors-hero-showcase"
      title="HeroShowcase"
      recipe="The whole hero composition — TabPill + AuroraGlow + DeviceBezel + auto-cycling Briefing / Inbox / MeetingPrep slots. Pauses on hover and when off-screen."
    >
      <VisitorsCanvas>
        <HeroShowcase />
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- MorningBriefingPanel ----------------------------- */

function MorningBriefingSection() {
  return (
    <Section
      id="visitors-morning-briefing"
      title="MorningBriefingPanel"
      recipe="Hero-grade briefing surface: integration tile row, greeting headline with inline pictographs, hairline divider, content pills (indigo / violet / peach / rose / amber)."
    >
      <VisitorsCanvas>
        <DeviceBezel>
          <MorningBriefingPanel className="rounded-none ring-0" />
        </DeviceBezel>
      </VisitorsCanvas>
    </Section>
  );
}

/* ----------------------------- Closing CTA + footer ----------------------------- */

function LandingCtaSectionPreview() {
  return (
    <Section
      id="visitors-cta"
      title="LandingCtaSection"
      recipe="Centered closing CTA. Uppercase eyebrow → big headline → muted sub → light FrostButton with arrow."
    >
      <VisitorsCanvas>
        <LandingCtaSection onGetStarted={() => undefined} />
      </VisitorsCanvas>
    </Section>
  );
}

function LandingFooterPreview() {
  return (
    <Section
      id="visitors-footer"
      title="LandingFooter"
      recipe="Dark, quiet footer — tagline column with operational pill + copyright, two grouped link columns. Sits on top-border neutral-900 hairline."
    >
      <div className="overflow-hidden rounded-2xl border border-white/10">
        <LandingFooter onGetStarted={() => undefined} healthOk={true} />
      </div>
    </Section>
  );
}
