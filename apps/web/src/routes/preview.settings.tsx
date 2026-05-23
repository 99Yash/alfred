import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  BadgeDollarSign,
  Bell,
  Gift,
  ListChecks,
  Mail,
  MessageSquare,
  PackageCheck,
  PencilLine,
  Slack,
  Sliders,
  Sparkles,
  Sunrise,
  Sunset,
  Tag,
  User,
  Users2,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import {
  VsButton,
  VsCard,
  VsInput,
  VsSegmented,
  VsSwitch,
  VsTextarea,
  VsThemed,
  VsThemeProvider,
  VsThemeToggle,
  type VsSegmentedItem,
} from "~/components/ui/visitors";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /settings.
 *
 * Same six sections (User, Billing, Plan, Features, Preferences, Referrals)
 * with the same form behavior wired to authClient.useSession() + signOut().
 *
 * What changed vs the dimension version
 * - One big PanelCard → many atomic VsCards (visitors.now's settings page
 *   uses one card per setting: project name, token, currency, public stats,
 *   delete — each is its own surface). Reads cleaner; small surfaces feel
 *   purposeful.
 * - Sidebar nav: dimension's left-bar accent rail → visitors-now active fill
 *   (bg-vs-bg-2) and icon brightening.
 * - Heading-display gradient title → plain ink heading.
 */
export const Route = createFileRoute("/preview/settings")({
  component: PreviewSettingsPage,
});

type SectionId = "user" | "billing" | "plan" | "features" | "preferences" | "referrals";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  { id: "user", label: "User", icon: User },
  { id: "billing", label: "Billing", icon: BadgeDollarSign },
  { id: "plan", label: "Plan", icon: PackageCheck },
  { id: "features", label: "Features", icon: Sparkles },
  { id: "preferences", label: "Preferences", icon: Sliders },
  { id: "referrals", label: "Referrals", icon: Gift },
];

function PreviewSettingsPage() {
  return (
    <VsThemeProvider>
      <PreviewSettingsBody />
    </VsThemeProvider>
  );
}

function PreviewSettingsBody() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <VsThemed className="min-h-dvh">
      <div className="fixed top-4 right-4 z-50">
        <VsThemeToggle />
      </div>
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-2 mb-10 vs-card-in">
          <h1 className="text-[36px] leading-[44px] font-medium text-vs-fg-4">Settings</h1>
          <p className="text-sm text-vs-fg-3">Manage your account.</p>
        </header>

        <div className="grid gap-8 grid-cols-1 md:grid-cols-[180px_1fr]">
          <SidebarNav active={section} onChange={setSection} />
          <div key={section} className="space-y-3 vs-card-in" style={{ animationDelay: "60ms" }}>
            <SectionPanel section={section} />
          </div>
        </div>

        <footer className="mt-16 flex items-center justify-center text-xs text-vs-fg-2 gap-2">
          <span>Comparing against</span>
          <Link to="/settings" className="font-medium text-vs-fg-3 hover:text-vs-fg-4">
            /settings
          </Link>
        </footer>
      </main>
    </VsThemed>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar nav                                                                 */
/* -------------------------------------------------------------------------- */

function SidebarNav({
  active,
  onChange,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
}) {
  return (
    <aside aria-label="Settings sections" className="md:sticky md:top-16 self-start">
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => (
          <SidebarRow
            key={s.id}
            section={s}
            active={active === s.id}
            onClick={() => onChange(s.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

function SidebarRow({
  section,
  active,
  onClick,
}: {
  section: SectionDef;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group inline-flex w-full items-center gap-2.5 rounded-full",
        "h-9 px-3 text-sm font-medium whitespace-nowrap",
        "transition-[background-color,color] duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        "vs-press",
        active
          ? "bg-vs-bg-2 text-vs-fg-4"
          : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      <Icon
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-150",
          active ? "text-vs-fg-4" : "text-vs-fg-2 group-hover:text-vs-fg-4",
        )}
      />
      <span>{section.label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Section panel switch                                                        */
/* -------------------------------------------------------------------------- */

function SectionPanel({ section }: { section: SectionId }) {
  if (section === "user") return <UserSection />;
  if (section === "features") return <FeaturesSection />;
  if (section === "preferences") return <PreferencesSection />;
  if (section === "billing") {
    return (
      <PlaceholderCard
        icon={BadgeDollarSign}
        title="Billing"
        description="Manage invoices, payment method, and billing contact."
      />
    );
  }
  if (section === "plan") {
    return (
      <PlaceholderCard
        icon={PackageCheck}
        title="Plan"
        description="Review your current plan and usage limits."
      />
    );
  }
  return (
    <PlaceholderCard
      icon={Gift}
      title="Referrals"
      description="Referral credit sharing arrives with billing."
    />
  );
}

/* -------------------------------------------------------------------------- */
/* SettingCard — the standard atomic surface                                   */
/* -------------------------------------------------------------------------- */

interface SettingCardProps {
  title: string;
  description?: string;
  /** Optional footer caption (left side, below the divider). */
  footer?: ReactNode;
  /** Optional footer action (right side, below the divider). */
  action?: ReactNode;
  /** When true, the footer divider is omitted. */
  noDivider?: boolean;
  children?: ReactNode;
}

function SettingCard({ title, description, footer, action, noDivider, children }: SettingCardProps) {
  return (
    <VsCard padded={false}>
      <div className="p-5 pb-3 space-y-1">
        <p className="text-sm font-medium text-vs-fg-4">{title}</p>
        {description ? <p className="text-xs text-vs-fg-3">{description}</p> : null}
      </div>
      {children ? <div className="px-5 pb-3">{children}</div> : null}
      {footer || action ? (
        <div
          className={cn(
            "flex items-center justify-between px-5 py-3",
            !noDivider && "border-t border-vs-bg-2",
          )}
        >
          <p className="text-xs text-vs-fg-2">{footer}</p>
          {action}
        </div>
      ) : null}
    </VsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* User section                                                                */
/* -------------------------------------------------------------------------- */

type CommunicationChannel = "email" | "slack" | "imessage" | "mobile";

const COMMUNICATION_CHANNELS: ReadonlyArray<VsSegmentedItem<CommunicationChannel>> = [
  { value: "email", label: "Email", icon: <Mail size={12} /> },
  { value: "slack", label: "Slack", icon: <Slack size={12} />, disabled: true },
  { value: "imessage", label: "iMessage", icon: <MessageSquare size={12} />, disabled: true },
  { value: "mobile", label: "Mobile", icon: <Bell size={12} />, disabled: true },
];

function UserSection() {
  const { data: session } = authClient.useSession();
  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";

  const [channel, setChannel] = useState<CommunicationChannel>("email");
  const [autoApprove, setAutoApprove] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
      await navigate({ to: "/login" });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
      <SettingCard
        title="Username"
        description="What should we call you?"
        footer="Profile editing arrives with the m13 settings backend."
        action={
          <VsButton size="sm" disabled>
            Save
          </VsButton>
        }
      >
        <VsInput
          defaultValue={name}
          placeholder="Your name"
          disabled
          aria-label="Username"
          className="!h-10 !rounded-2xl"
        />
      </SettingCard>

      <SettingCard
        title="Email"
        description="Manage the email you use to sign into Alfred."
        footer="Used to identify your account."
      >
        <VsInput value={email} readOnly aria-label="Email" className="!h-10 !rounded-2xl" />
      </SettingCard>

      <SettingCard
        title="Preferred mode of communication"
        description="Choose how Alfred should reach you with briefings and approvals."
      >
        <VsSegmented<CommunicationChannel>
          value={channel}
          onValueChange={setChannel}
          items={COMMUNICATION_CHANNELS}
          label="Preferred mode of communication"
        />
      </SettingCard>

      <SettingCard
        title="Auto approve"
        description="Skip the approval prompt for low-risk actions Alfred takes on your behalf."
        noDivider
        action={<VsSwitch checked={autoApprove} onCheckedChange={setAutoApprove} />}
      />

      <SettingCard
        title="Background"
        description="Tell Alfred about yourself — used to ground every response."
        footer="Background editing arrives with the m13 settings backend."
      >
        <VsTextarea
          rows={5}
          placeholder="A few sentences about who you are, how you work, and what context you'd like Alfred to keep in mind."
          disabled
          aria-label="Background"
        />
      </SettingCard>

      <SettingCard
        title="Logout from this account"
        description="Sign out on this device."
        noDivider
        action={
          <VsButton
            variant="destructive"
            size="md"
            onClick={onSignOut}
            disabled={signingOut}
            loading={signingOut}
          >
            Logout
          </VsButton>
        }
      />

      <SettingCard
        title="Delete account"
        description="Permanently delete your account and data."
        footer="Proceed with caution. This action cannot be undone."
        action={
          <VsButton
            variant="destructive"
            size="md"
            disabled
            title="Account deletion arrives with the m13 settings backend"
          >
            Delete account
          </VsButton>
        }
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Features section                                                            */
/* -------------------------------------------------------------------------- */

interface BackgroundAgentDef {
  id: string;
  label: string;
  helper: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  tint: "purple" | "amber" | "sky" | "green" | "pink" | "orange";
  defaultOn: boolean;
}

const BACKGROUND_AGENTS: ReadonlyArray<BackgroundAgentDef> = [
  { id: "action-items", label: "Action items", helper: "Pulls action items from your apps and flags what's urgent.", icon: ListChecks, tint: "purple", defaultOn: true },
  { id: "evening-recap", label: "Evening recap", helper: "A daily summary of what got done and what's still open.", icon: Sunset, tint: "orange", defaultOn: false },
  { id: "morning-briefing", label: "Morning briefing", helper: "Your schedule, tasks, and key updates — delivered each morning.", icon: Sunrise, tint: "amber", defaultOn: true },
  { id: "email-tagging", label: "Email tagging", helper: "Tags every inbound email so you know what needs action.", icon: Tag, tint: "green", defaultOn: true },
  { id: "email-auto-drafting", label: "Email auto-drafting", helper: "Drafts replies in your tone so you can review and send.", icon: PencilLine, tint: "sky", defaultOn: false },
  { id: "meeting-prep", label: "Meeting prep", helper: "Briefs you on attendees, talking points, and past context.", icon: Users2, tint: "pink", defaultOn: false },
];

const TINT_TILE: Record<BackgroundAgentDef["tint"], string> = {
  purple: "bg-vs-purple-1 text-vs-purple-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
  sky: "bg-vs-sky-1 text-vs-sky-4",
  green: "bg-vs-green-1 text-vs-green-4",
  pink: "bg-vs-pink-1 text-vs-pink-4",
  orange: "bg-vs-orange-1 text-vs-orange-4",
};

function FeaturesSection() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(BACKGROUND_AGENTS.map((a) => [a.id, a.defaultOn])),
  );

  return (
    <VsCard padded={false}>
      <div className="p-5 pb-2 space-y-1">
        <p className="text-sm font-medium text-vs-fg-4">Background agents</p>
        <p className="text-xs text-vs-fg-3">Enable or disable the agents that run on your behalf.</p>
      </div>
      <div className="divide-y divide-vs-bg-2">
        {BACKGROUND_AGENTS.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            checked={enabled[agent.id] ?? false}
            onChange={(next) => setEnabled((prev) => ({ ...prev, [agent.id]: next }))}
          />
        ))}
      </div>
    </VsCard>
  );
}

function AgentRow({
  agent,
  checked,
  onChange,
}: {
  agent: BackgroundAgentDef;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const Icon = agent.icon;
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-xl", TINT_TILE[agent.tint])} aria-hidden>
          <Icon size={14} />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-vs-fg-4">{agent.label}</p>
          <p className="text-xs text-vs-fg-3 truncate">{agent.helper}</p>
        </div>
      </div>
      <VsSwitch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Preferences section                                                         */
/* -------------------------------------------------------------------------- */

function PreferencesSection() {
  const [productUpdates, setProductUpdates] = useState(true);

  return (
    <>
      <SettingCard
        title="Default model"
        description="Model Alfred uses to reason. Picker lands with milestone 13."
      >
        <div className="inline-flex items-center gap-2 rounded-full px-3 h-9 bg-vs-bg-2 text-sm text-vs-fg-3">
          <Sparkles size={13} className="text-vs-fg-2" />
          <span>Alfred (default)</span>
        </div>
      </SettingCard>

      <SettingCard
        title="Product updates"
        description="Get notified about new features and improvements."
        noDivider
        action={<VsSwitch checked={productUpdates} onCheckedChange={setProductUpdates} />}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Placeholder card for sections without backend                               */
/* -------------------------------------------------------------------------- */

function PlaceholderCard({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <VsCard padded={false} className="px-5 py-10 flex flex-col items-center gap-2 text-center">
      <span className="grid size-9 place-items-center rounded-full border border-vs-bg-3 text-vs-fg-3" aria-hidden>
        <Icon size={16} />
      </span>
      <p className="text-sm font-medium text-vs-fg-4">{title}</p>
      <p className="text-xs text-vs-fg-3 max-w-xs">{description}</p>
      <p className="text-xs text-vs-fg-2 mt-2">
        This section is wired in milestone 13 alongside the settings backend.
      </p>
    </VsCard>
  );
}
