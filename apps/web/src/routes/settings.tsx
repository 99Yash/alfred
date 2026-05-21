import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/* -------------------------------------------------------------------------- */
/* Section registry                                                            */
/* -------------------------------------------------------------------------- */

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

function SettingsPage() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />

      <header className="mb-8 sm:mb-10">
        <h1 className="heading-display text-[34px] sm:text-[40px] leading-[40px] sm:leading-[48px] font-medium tracking-tight">
          Settings
        </h1>
      </header>

      <div className="grid gap-6 sm:gap-8 grid-cols-1 md:grid-cols-[200px_1fr]">
        <SettingsNav active={section} onChange={setSection} />
        <SettingsPanel section={section} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inner nav                                                                  */
/* -------------------------------------------------------------------------- */

function SettingsNav({
  active,
  onChange,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
}) {
  return (
    <aside aria-label="Settings sections" className="md:sticky md:top-10">
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => (
          <SettingsNavRow
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

function SettingsNavRow({
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
        "group relative inline-flex w-full items-center gap-2.5 rounded-md",
        "h-8 px-2.5 text-[13.5px] font-medium whitespace-nowrap",
        "transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500",
        "active:scale-[0.98]",
        active
          ? "bg-white/[0.05] text-gray-1000"
          : "text-gray-800 hover:bg-white/[0.025] hover:text-gray-900",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute -left-2 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-[rgb(var(--purple-400))]",
          "transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          active ? "opacity-100 scale-y-100" : "opacity-0 scale-y-50",
        )}
      />
      <Icon
        size={14}
        className={cn(
          "shrink-0 transition-[color] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          active ? "text-gray-1000" : "text-gray-800 group-hover:text-gray-900",
        )}
      />
      <span>{section.label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel — section switch                                                     */
/* -------------------------------------------------------------------------- */

function SettingsPanel({ section }: { section: SectionId }) {
  let panel: ReactNode;
  if (section === "user") panel = <UserSection />;
  else if (section === "billing")
    panel = (
      <SimpleSection
        icon={BadgeDollarSign}
        title="Billing"
        description="Manage invoices, payment method, and billing contact."
      />
    );
  else if (section === "plan")
    panel = (
      <SimpleSection
        icon={PackageCheck}
        title="Plan"
        description="Review your current plan and usage limits."
      />
    );
  else if (section === "features") panel = <FeaturesSection />;
  else if (section === "preferences") panel = <PreferencesSection />;
  else
    panel = (
      <SimpleSection
        icon={Gift}
        title="Referrals"
        description="Referral credit sharing arrives with billing."
      />
    );

  return (
    <div key={section} className="animate-settings-panel-in">
      {panel}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel shell                                                                */
/* -------------------------------------------------------------------------- */

function PanelCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-[rgb(var(--gray-25)/0.4)] p-6 sm:p-8 space-y-7">
      {children}
    </div>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-gray-1000">
        <Icon size={14} className="text-gray-900" />
        <p className="text-base font-medium">{title}</p>
      </div>
      <p className="text-[12.5px] text-gray-800">{description}</p>
    </div>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <label className="text-sm font-medium text-gray-1000">{label}</label>
        {helper ? <p className="text-[12px] text-gray-800">{helper}</p> : null}
      </div>
      {children}
    </div>
  );
}

function FieldRow({
  label,
  helper,
  control,
}: {
  label: string;
  helper?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-gray-1000">{label}</p>
        {helper ? <p className="text-[12px] text-gray-800">{helper}</p> : null}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function Cluster({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-[13px] font-medium text-gray-1000">{title}</h3>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function AgentRow({
  icon: Icon,
  label,
  helper,
  checked,
  onChange,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  helper: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
            "border border-white/5 bg-[rgb(var(--gray-50)/0.5)] text-gray-900",
          )}
        >
          <Icon size={13} />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-gray-1000">{label}</p>
          <p className="text-[12px] text-gray-800">{helper}</p>
        </div>
      </div>
      <div className="shrink-0 pt-1">
        <Switch checked={checked} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* User section                                                               */
/* -------------------------------------------------------------------------- */

type CommunicationChannel = "email" | "slack" | "imessage" | "mobile";

const COMMUNICATION_CHANNELS: ReadonlyArray<TabItem<CommunicationChannel>> = [
  { value: "email", label: "Email", icon: <Mail size={13} /> },
  { value: "slack", label: "Slack", icon: <Slack size={13} />, disabled: true },
  { value: "imessage", label: "iMessage", icon: <MessageSquare size={13} />, disabled: true },
  { value: "mobile", label: "Mobile", icon: <Bell size={13} />, disabled: true },
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
    <PanelCard>
      <PanelHeader
        icon={User}
        title="Account Information"
        description="Update your account details."
      />

      <Field label="Username" helper="What should we call you?">
        <Input
          defaultValue={name}
          placeholder="Your name"
          disabled
          aria-label="Username"
          title="Profile editing arrives with the m13 settings backend"
        />
      </Field>

      <Field label="Email" helper="Manage the email you use to sign into Alfred.">
        <Input value={email} disabled aria-label="Email" />
      </Field>

      <Field
        label="Preferred Mode of Communication"
        helper="Choose how Alfred should reach you with briefings and approvals."
      >
        <Tabs<CommunicationChannel>
          variant="pill"
          value={channel}
          onValueChange={setChannel}
          items={COMMUNICATION_CHANNELS}
          label="Preferred mode of communication"
        />
      </Field>

      <FieldRow
        label="Auto Approve"
        helper="Skip the approval prompt for low-risk actions Alfred takes on your behalf."
        control={<Switch checked={autoApprove} onCheckedChange={setAutoApprove} />}
      />

      <Field
        label="Background"
        helper="Tell Alfred about yourself — used to ground every response."
      >
        <Textarea
          variant="card"
          rows={5}
          placeholder="A few sentences about who you are, how you work, and what context you'd like Alfred to keep in mind."
          disabled
          title="Background editing arrives with the m13 settings backend"
          aria-label="Background"
        />
      </Field>

      <div className="space-y-1 border-t border-white/5 pt-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-gray-1000">Logout from this account</p>
            <p className="text-[12px] text-gray-800">Sign out on this device.</p>
          </div>
          <Button
            variant="destructive"
            size="md"
            onClick={onSignOut}
            disabled={signingOut}
            loading={signingOut}
          >
            Logout
          </Button>
        </div>
      </div>

      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-gray-1000">Delete Account</p>
          <p className="text-[12px] text-gray-800">Permanently delete your account and data.</p>
        </div>
        <Button
          variant="destructive"
          size="md"
          disabled
          title="Account deletion arrives with the m13 settings backend"
        >
          Delete Account
        </Button>
      </div>
    </PanelCard>
  );
}

function SimpleSection({
  icon,
  title,
  description,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <PanelCard>
      <PanelHeader icon={icon} title={title} description={description} />
      <p className="text-[12.5px] text-gray-800">
        This preserves the Dimension settings navigation shape while the backend for this section
        lands.
      </p>
    </PanelCard>
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
  defaultOn: boolean;
}

const BACKGROUND_AGENTS: ReadonlyArray<BackgroundAgentDef> = [
  {
    id: "action-items",
    label: "Action Items",
    helper: "Pulls action items from your apps and flags what's urgent.",
    icon: ListChecks,
    defaultOn: true,
  },
  {
    id: "evening-recap",
    label: "Evening Recap",
    helper: "A daily summary of what got done and what's still open.",
    icon: Sunset,
    defaultOn: false,
  },
  {
    id: "morning-briefing",
    label: "Morning Briefing",
    helper: "Your schedule, tasks, and key updates — delivered each morning.",
    icon: Sunrise,
    defaultOn: true,
  },
  {
    id: "email-tagging",
    label: "Email Tagging",
    helper: "Tags every inbound email so you know what needs action.",
    icon: Tag,
    defaultOn: true,
  },
  {
    id: "email-auto-drafting",
    label: "Email Auto-Drafting",
    helper: "Drafts replies in your tone so you can review and send.",
    icon: PencilLine,
    defaultOn: false,
  },
  {
    id: "meeting-prep",
    label: "Meeting Prep",
    helper: "Briefs you on attendees, talking points, and past context.",
    icon: Users2,
    defaultOn: false,
  },
];

function FeaturesSection() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(BACKGROUND_AGENTS.map((a) => [a.id, a.defaultOn])),
  );

  return (
    <PanelCard>
      <PanelHeader
        icon={Sparkles}
        title="Features"
        description="Enable or disable background agents."
      />

      <Cluster title="Background Agents">
        {BACKGROUND_AGENTS.map((agent) => (
          <AgentRow
            key={agent.id}
            icon={agent.icon}
            label={agent.label}
            helper={agent.helper}
            checked={enabled[agent.id] ?? false}
            onChange={(next) => setEnabled((prev) => ({ ...prev, [agent.id]: next }))}
          />
        ))}
      </Cluster>
    </PanelCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Preferences section                                                         */
/* -------------------------------------------------------------------------- */

function PreferencesSection() {
  const [productUpdates, setProductUpdates] = useState(true);

  return (
    <PanelCard>
      <PanelHeader
        icon={Sliders}
        title="Preferences"
        description="Customize your app preferences."
      />

      <Cluster title="Model">
        <Field
          label="Default model"
          helper="Model Alfred uses to reason. Picker lands with milestone 13."
        >
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 h-9",
              "border border-gray-100 bg-[rgb(var(--gray-50)/0.5)]",
              "text-sm text-gray-800",
            )}
          >
            <Sparkles size={13} className="text-gray-900" />
            <span>Alfred (default)</span>
          </div>
        </Field>
      </Cluster>

      <Cluster title="Email Preferences">
        <FieldRow
          label="Product Updates"
          helper="Get notified about new features and improvements."
          control={<Switch checked={productUpdates} onCheckedChange={setProductUpdates} />}
        />
      </Cluster>
    </PanelCard>
  );
}
