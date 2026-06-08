import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  FileText,
  LogOut,
  Mail,
  MessageSquare,
  Radio,
  ShieldCheck,
  Slack,
  Trash2,
  User,
} from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  AppInput,
  AppSegmented,
  AppSwitch,
  AppTextarea,
  type AppSegmentedItem,
} from "~/components/ui/v2";
import { authClient } from "~/lib/auth-client";
import { SettingCard } from "./setting-card";

type CommunicationChannel = "email" | "slack" | "imessage" | "mobile";

const COMMUNICATION_CHANNELS: ReadonlyArray<AppSegmentedItem<CommunicationChannel>> = [
  { value: "email", label: "Email", icon: <Mail size={12} /> },
  { value: "slack", label: "Slack", icon: <Slack size={12} />, disabled: true },
  { value: "imessage", label: "iMessage", icon: <MessageSquare size={12} />, disabled: true },
  { value: "mobile", label: "Mobile", icon: <Bell size={12} />, disabled: true },
];

export function UserSection() {
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
        footer="Background editing arrives with the m13 settings backend."
      >
        <AppTextarea
          rows={5}
          placeholder="A few sentences about who you are, how you work, and what context you'd like Alfred to keep in mind."
          disabled
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
