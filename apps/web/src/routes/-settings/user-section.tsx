import { useNavigate } from "@tanstack/react-router";
import { FileText, LogOut, Mail, Radio, ShieldCheck, Smartphone, Trash2, User } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSegmented,
  AppSwitch,
  AppTextarea,
  type AppSegmentedItem,
} from "~/components/ui/v2";
import { authClient } from "~/lib/auth/auth-client";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { useBioFact } from "~/lib/replicache/use-bio-fact";
import { toast } from "~/lib/toast";
import { SettingCard } from "./setting-card";

/** Quiet period after the last keystroke before the bio auto-saves. */
const BIO_SAVE_DEBOUNCE_MS = 900;

type CommunicationChannel = "email" | "slack" | "imessage" | "mobile";

/** Apple Messages green bubble — no brand asset in the integration set, so
 * inline. Filled to sit alongside the multicolor Gmail/Slack marks rather
 * than reading as a thin lucide outline. */
function MessagesGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M12 2.75c-5.66 0-10 3.7-10 8.34 0 2.62 1.43 4.95 3.74 6.5.18 1.27-.45 2.86-1.32 3.91-.18.22-.02.55.26.5 1.96-.33 3.66-1.05 4.9-1.92.78.16 1.59.25 2.42.25 5.66 0 10-3.7 10-8.34S17.66 2.75 12 2.75Z"
        fill="#34C759"
      />
    </svg>
  );
}

const COMMUNICATION_CHANNELS: ReadonlyArray<AppSegmentedItem<CommunicationChannel>> = [
  { value: "email", label: "Email", icon: <IntegrationGlyph brand="gmail" size={14} /> },
  {
    value: "slack",
    label: "Slack",
    icon: <IntegrationGlyph brand="slack" size={14} />,
    disabled: true,
  },
  { value: "imessage", label: "iMessage", icon: <MessagesGlyph size={14} />, disabled: true },
  { value: "mobile", label: "Mobile", icon: <Smartphone size={13} />, disabled: true },
];

export function UserSection() {
  const { data: session } = authClient.useSession();
  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";

  const [channel, setChannel] = useState<CommunicationChannel>("email");
  const [autoApprove, setAutoApprove] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  // Background: `draft === null` means "mirror the synced value"; once the user
  // types, the draft takes over so an incoming pull can't clobber their edit.
  // Edits auto-save on a trailing debounce — no explicit Save button.
  const { value: bio, loading: bioLoading, saveBio } = useBioFact();
  const [bioDraft, setBioDraft] = useState<string | null>(null);
  const [bioSaving, setBioSaving] = useState(false);
  const bioValue = bioDraft ?? bio;

  useEffect(() => {
    if (bioDraft === null) return; // untouched — nothing to persist
    const next = bioDraft.trim();
    if (next === bio.trim()) return; // matches synced truth (incl. post-save)
    if (next === "") return; // don't let a transient empty wipe the bio
    const timer = setTimeout(async () => {
      setBioSaving(true);
      try {
        await saveBio(next);
        toast.success("Background saved");
      } catch {
        toast.error("Couldn't save background");
      } finally {
        setBioSaving(false);
      }
    }, BIO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [bioDraft, bio, saveBio]);

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
        icon={User}
        tone="purple"
        footer="Profile editing arrives with the m13 settings backend."
        action={
          <AppButton size="sm" disabled>
            Save
          </AppButton>
        }
      >
        <AppInput
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
        icon={Mail}
        tone="sky"
        footer="Used to identify your account."
      >
        <AppInput value={email} readOnly aria-label="Email" className="!h-10 !rounded-2xl" />
      </SettingCard>

      <SettingCard
        title="Preferred mode of communication"
        description="Choose how Alfred should reach you with briefings and approvals."
        icon={Radio}
        tone="amber"
      >
        <AppSegmented<CommunicationChannel>
          value={channel}
          onValueChange={setChannel}
          items={COMMUNICATION_CHANNELS}
          label="Preferred mode of communication"
        />
      </SettingCard>

      <SettingCard
        title="Auto approve"
        description="Skip the approval prompt for low-risk actions Alfred takes on your behalf."
        icon={ShieldCheck}
        tone="green"
        noDivider
        action={
          <AppSwitch
            checked={autoApprove}
            onCheckedChange={setAutoApprove}
            aria-label="Auto approve low-risk actions"
          />
        }
      />

      <SettingCard
        title="Background"
        description="Tell Alfred about yourself — used to ground every response."
        icon={FileText}
        tone="pink"
        footer={bioSaving ? "Saving…" : "Alfred drafts this from research. Edits save as you type."}
      >
        <AppTextarea
          rows={5}
          value={bioValue}
          onChange={(e) => setBioDraft(e.target.value)}
          placeholder="A few sentences about who you are, how you work, and what context you'd like Alfred to keep in mind."
          disabled={bioLoading}
          aria-label="Background"
        />
      </SettingCard>

      <SettingCard
        title="Logout from this account"
        description="Sign out on this device."
        icon={LogOut}
        tone="orange"
        noDivider
        action={
          <AppButton
            variant="destructive"
            size="md"
            onClick={onSignOut}
            disabled={signingOut}
            loading={signingOut}
          >
            Logout
          </AppButton>
        }
      />

      <SettingCard
        title="Delete account"
        description="Permanently delete your account and data."
        icon={Trash2}
        tone="red"
        footer="Proceed with caution. This action cannot be undone."
        action={
          <AppButton
            variant="destructive"
            size="md"
            disabled
            title="Account deletion arrives with the m13 settings backend"
          >
            Delete account
          </AppButton>
        }
      />
    </>
  );
}
