import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bell,
  LogOut,
  Plug,
  ShieldAlert,
  Sliders,
  Sparkles,
  User,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { authClient } from "~/lib/auth-client";
import { useTheme, type Theme } from "~/lib/theme";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/* -------------------------------------------------------------------------- */
/* Section registry                                                            */
/* -------------------------------------------------------------------------- */

type SectionId = "user" | "integrations" | "notifications" | "preferences" | "danger";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  { id: "user", label: "User", icon: User },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "preferences", label: "Preferences", icon: Sliders },
  { id: "danger", label: "Danger", icon: ShieldAlert },
];

function SettingsPage() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />

      <header className="mb-10">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Settings
        </h1>
      </header>

      <div className="grid gap-8 md:grid-cols-[180px_1fr]">
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
      <nav className="flex flex-row md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">
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
        "group relative inline-flex items-center gap-2 rounded-md",
        "h-8 px-2 text-sm font-medium whitespace-nowrap",
        "transition-colors duration-200",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500",
        active
          ? "text-gray-1000"
          : "text-gray-800 hover:text-gray-900",
      )}
    >
      {active ? (
        <span
          aria-hidden
          /* 2px purple left bar — vertical orientation on desktop, hidden on
           * mobile where the nav goes horizontal and the bar would be wrong. */
          className="hidden md:block absolute left-[-10px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-[rgb(var(--purple-400))]"
        />
      ) : null}
      <Icon size={14} className="shrink-0" />
      <span>{section.label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel — section switch                                                     */
/* -------------------------------------------------------------------------- */

function SettingsPanel({ section }: { section: SectionId }) {
  if (section === "user") return <UserSection />;
  if (section === "integrations") return <IntegrationsSection />;
  if (section === "notifications") return <NotificationsSection />;
  if (section === "preferences") return <PreferencesSection />;
  return <DangerSection />;
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

/* -------------------------------------------------------------------------- */
/* User section                                                               */
/* -------------------------------------------------------------------------- */

function UserSection() {
  const { data: session } = authClient.useSession();
  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";

  return (
    <PanelCard>
      <PanelHeader
        icon={User}
        title="Account Information"
        description="Update your account details."
      />

      <Field
        label="Username"
        helper="What should we call you?"
      >
        <Input
          defaultValue={name}
          placeholder="Your name"
          disabled
          aria-label="Username"
          title="Profile editing arrives with the m13 settings backend"
        />
      </Field>

      <Field
        label="Email"
        helper="Manage the email you use to sign into Alfred."
      >
        <Input
          value={email}
          disabled
          aria-label="Email"
        />
      </Field>

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
    </PanelCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Integrations section — link to /integrations                               */
/* -------------------------------------------------------------------------- */

function IntegrationsSection() {
  const navigate = useNavigate();
  return (
    <PanelCard>
      <PanelHeader
        icon={Plug}
        title="Connected tools"
        description="Manage the integrations Alfred can read, write, and act on."
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-[12.5px] text-gray-800">
          Integration management lives on its own surface.
        </p>
        <Button
          variant="ghost"
          size="md"
          onClick={() => navigate({ to: "/integrations" })}
        >
          Open Integrations
        </Button>
      </div>
    </PanelCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Notifications section                                                       */
/* -------------------------------------------------------------------------- */

function NotificationsSection() {
  /* Local state — the toggles are not wired to the backend yet. m10's
   * morning-briefing currently runs unconditionally for the single user;
   * auto-approve lives in the home composer only. Settings will own these
   * when the m13 settings backend lands. */
  const [briefing, setBriefing] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);

  return (
    <PanelCard>
      <PanelHeader
        icon={Bell}
        title="Notifications"
        description="Choose what Alfred sends you and when."
      />

      <FieldRow
        label="Morning briefing"
        helper="Inbox-only digest delivered every morning. Wired in milestone 10."
        control={<Switch checked={briefing} onCheckedChange={setBriefing} />}
      />

      <FieldRow
        label="Auto approve"
        helper="When enabled, low-risk internal changes execute without asking for review."
        control={<Switch checked={autoApprove} onCheckedChange={setAutoApprove} />}
      />
    </PanelCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Preferences section                                                         */
/* -------------------------------------------------------------------------- */

const THEME_TABS: ReadonlyArray<TabItem<Theme>> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function PreferencesSection() {
  const { theme, setTheme } = useTheme();

  return (
    <PanelCard>
      <PanelHeader
        icon={Sliders}
        title="Preferences"
        description="Tune the surfaces Alfred shows you."
      />

      <Field
        label="Theme"
        helper="Choose Alfred's appearance. System matches your OS."
      >
        <Tabs<Theme>
          variant="pill"
          value={theme}
          onValueChange={setTheme}
          items={THEME_TABS}
          label="Theme"
        />
      </Field>

      <Field
        label="Model"
        helper="Default model Alfred uses to reason. Picker lands with milestone 13."
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
    </PanelCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Danger section                                                              */
/* -------------------------------------------------------------------------- */

function DangerSection() {
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    if (signingOut) return;
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
        icon={ShieldAlert}
        title="Danger zone"
        description="Account-level actions. These are deliberate — review before pressing."
      />

      <FieldRow
        label="Logout from this account"
        helper="You can sign back in any time with the same email."
        control={
          <Button
            variant="destructive"
            size="md"
            leading={<LogOut size={14} />}
            onClick={signOut}
            loading={signingOut}
          >
            Logout
          </Button>
        }
      />

      <FieldRow
        label="Delete account"
        helper="Permanently delete your account and all associated data. Wired with the m13 settings backend."
        control={
          <Button
            variant="destructive"
            size="md"
            leading={<AlertTriangle size={14} />}
            disabled
            title="Account deletion arrives with the m13 settings backend"
          >
            Delete account
          </Button>
        }
      />
    </PanelCard>
  );
}
