import { useNavigate } from "@tanstack/react-router";
import {
  assertNever,
  humanizeToolName,
  integrationFromToolName,
  type ApprovalSetting,
} from "@alfred/contracts";
import type { SyncedChatToolCall } from "@alfred/sync";
import { ArrowRight } from "lucide-react";
import { toast } from "~/lib/toast";
import { useThreadActions } from "~/lib/chat/use-thread-actions";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/**
 * The settings that remove the cards of one turn (ADR-0130 decision 4), first appearance first.
 * The model writes the words in the reply. These rows only give the links.
 */
export function collectApprovalSettings(
  toolCalls: readonly SyncedChatToolCall[],
): ApprovalSetting[] {
  const byKey = new Map<string, ApprovalSetting>();

  for (const call of toolCalls) {
    for (const setting of call.approvalCause?.settings ?? []) {
      const key = approvalSettingKey(setting);

      if (!byKey.has(key)) byKey.set(key, setting);
    }
  }

  return [...byKey.values()];
}

function approvalSettingKey(setting: ApprovalSetting): string {
  switch (setting.kind) {
    case "integration_mode":
      return `integration_mode:${setting.integration}`;
    case "always_allow":
      return `always_allow:${setting.toolName}`;
    case "full_autonomy":
      return "full_autonomy";
    default:
      return assertNever(setting, "approval setting");
  }
}

interface SettingLink {
  key: string;
  label: string;
  /** The integration page, or the integrations list when the slug has no page. */
  slug: string | undefined;
}

function settingLink(setting: ApprovalSetting): SettingLink | null {
  switch (setting.kind) {
    case "integration_mode": {
      const page = getIntegrationPage(setting.integration);

      return {
        key: approvalSettingKey(setting),
        label: `${page?.name ?? "Integration"} settings`,
        slug: page?.slug,
      };
    }

    case "always_allow":
      return {
        key: approvalSettingKey(setting),
        label: `Always allow ${humanizeToolName(setting.toolName)}`,
        slug: getIntegrationPage(integrationFromToolName(setting.toolName))?.slug,
      };
    case "full_autonomy":
      return null;
    default:
      return assertNever(setting, "approval setting");
  }
}

/**
 * Links to the settings that remove this turn's cards, under the reply. Nothing when the turn had
 * no card with a cause. Full Autonomy is a button, because it is a flag on this thread.
 * The sync query sits in `SettingRows`, below the empty-case return, so a turn with no card
 * mounts no subscription.
 */
export function ApprovalSettingRows({
  settings,
  threadId,
}: {
  settings: readonly ApprovalSetting[];
  threadId: string;
}) {
  if (settings.length === 0) return null;

  return <SettingRows settings={settings} threadId={threadId} />;
}

function SettingRows({
  settings,
  threadId,
}: {
  settings: readonly ApprovalSetting[];
  threadId: string;
}) {
  const navigate = useNavigate();
  // Undefined on a shared page with no sync, so the Full Autonomy button does not show there.
  const threadActions = useThreadActions(threadId);
  const links = settings.map(settingLink).filter((link) => link !== null);

  const offersFullAutonomy =
    threadActions !== undefined && settings.some((setting) => setting.kind === "full_autonomy");

  if (links.length === 0 && !offersFullAutonomy) return null;

  return (
    <div
      className={cn(
        "app-fade-in flex w-fit max-w-full flex-wrap items-center gap-x-4 gap-y-1.5",
        "rounded-surface bg-app-bg-2 px-3 py-2",
      )}
    >
      {links.map((link) => (
        <SettingButton
          key={link.key}
          label={link.label}
          onClick={() =>
            void (link.slug === undefined
              ? navigate({ to: "/integrations" })
              : navigate({ to: "/integrations/$slug", params: { slug: link.slug } }))
          }
        />
      ))}
      {offersFullAutonomy ? (
        <SettingButton
          label="Full Autonomy for this chat"
          onClick={() =>
            void threadActions.setApprovalMode(threadId, "full").catch(() => {
              toast.error("Couldn't turn on Full Autonomy. Please try again.");
            })
          }
        />
      ) : null}
    </div>
  );
}

function SettingButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/setting inline-flex items-center gap-1 rounded-control-sm text-[13px] font-medium",
        "text-app-purple-4 outline-none",
        "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {label}
      <ArrowRight
        size={13}
        aria-hidden
        className="transition-transform duration-200 group-hover/setting:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}
