/**
 * Internal styleguide — preview every Dimension-grammar primitive in isolation.
 *
 * Visit /styleguide on a dev build. Each primitive shows its default, hover-
 * able, focusable, active, and disabled states alongside the corresponding
 * recipe from references/dimension-dev/dimension-design-reference-2026-05-18.md.
 *
 * Add new primitives to this page as they're built so the next agent (or you,
 * after a context compaction) can verify each one in one place without
 * touching real routes.
 */

import { createFileRoute } from "@tanstack/react-router";
import {
  Archive,
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
import { useState } from "react";
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

export const Route = createFileRoute("/styleguide")({
  component: StyleguidePage,
});

function StyleguidePage() {
  return (
    <div className="min-h-[100dvh] bg-[rgb(12,12,12)] text-gray-950">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 space-y-16">
        <header className="space-y-3">
          <p className="text-sm text-gray-800">Internal · Stage&nbsp;1 primitives preview</p>
          <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
            Alfred UI styleguide
          </h1>
          <p className="text-sm text-gray-800 max-w-prose">
            Every primitive in{" "}
            <code className="font-mono text-[12px] text-green-400">
              apps/web/src/components/ui/
            </code>{" "}
            rendered with default / hover / focus / active / disabled states. Cross-reference{" "}
            <code className="font-mono text-[12px] text-green-400">
              references/dimension-dev/dimension-design-reference-2026-05-18.md
            </code>{" "}
            §2 for the recipes.
          </p>
        </header>

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
        <QuickAccessRail healthOk healthLoading={false} />
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
          Frost panel — used for code blocks and structured agent output. Holds a hairline plus an
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
