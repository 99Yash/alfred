import { useNavigate } from "@tanstack/react-router";
import {
  approvalSettings,
  APPROVAL_CONTROL_LABELS,
  assertNever,
  humanizeToolName,
  integrationFromToolName,
  type ApprovalReason,
  type ApprovalSetting,
} from "@alfred/contracts";
import type { SyncedActionPolicy, SyncedChatToolCall } from "@alfred/sync";
import { ArrowRight } from "lucide-react";
import { requestApprovalModePicker } from "~/lib/chat/approval-mode-picker-request";
import { useThreadActions } from "~/lib/chat/use-thread-actions";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/** The reasons of the cards of one turn (ADR-0130 amendment (c)), in call order. */
export function collectApprovalReasons(toolCalls: readonly SyncedChatToolCall[]): ApprovalReason[] {
  return toolCalls.flatMap((call) => (call.approvalReason ? [call.approvalReason] : []));
}

/**
 * The settings that remove the cards of one turn under current policy, first appearance first
 * (ADR-0130 amendment (c)). The saved reply is in a chat thread, so Full Autonomy applies.
 */
function settingsOf(
  reasons: readonly ApprovalReason[],
  policy: SyncedActionPolicy,
): ApprovalSetting[] {
  const byKey = new Map<string, ApprovalSetting>();

  for (const reason of reasons) {
    for (const setting of approvalSettings(reason, policy, true)) {
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
    case "always_allow_server_tool":
      return `always_allow_server_tool:${setting.serverTool.connectionId}:${setting.serverTool.remoteName}`;
    case "full_autonomy":
      return "full_autonomy";
    default:
      return assertNever(setting, "approval setting");
  }
}

interface SettingLink {
  key: string;
  label: string;
  /** What the setting authorizes (ADR-0130 amendment (c)). */
  scope: string;
  /** The integration page, or the integrations list when the slug has no page. */
  slug: string | undefined;
}

function settingLink(setting: ApprovalSetting): SettingLink | null {
  switch (setting.kind) {
    case "integration_mode": {
      const page = getIntegrationPage(setting.integration);

      return {
        key: approvalSettingKey(setting),
        label: `${page?.name ?? "Integration"} ${APPROVAL_CONTROL_LABELS.approvalPolicy.toLowerCase()}`,
        scope: "This integration",
        slug: page?.slug,
      };
    }

    // The integration page lists the exceptions of its tools and adds one.
    case "always_allow": {
      const page = getIntegrationPage(integrationFromToolName(setting.toolName));

      return {
        key: approvalSettingKey(setting),
        label: `${APPROVAL_CONTROL_LABELS.alwaysAllowAction}: ${humanizeToolName(setting.toolName)}`,
        scope: "This action",
        slug: page?.slug,
      };
    }

    // The server's tools, from its connection: on its provider's page, else on the list.
    case "always_allow_server_tool": {
      const page = getIntegrationPage(setting.integration);

      return {
        key: approvalSettingKey(setting),
        label: `${APPROVAL_CONTROL_LABELS.alwaysAllowAction}: ${setting.serverTool.remoteName}`,
        scope: "This action",
        slug: page?.slug,
      };
    }

    // A button opens the approval mode picker instead.
    case "full_autonomy":
      return null;
    default:
      return assertNever(setting, "approval setting");
  }
}

/**
 * Links to the settings that remove this turn's cards, under the reply, each with its scope.
 * Nothing when the turn had no card with a reason. Full Autonomy opens the approval mode picker
 * of this thread (ADR-0069), so it never turns on at once.
 * The sync queries sit in `SettingRows`, below the empty-case return, so a turn with no card
 * mounts no subscription.
 */
export function ApprovalSettingRows({
  reasons,
  threadId,
}: {
  reasons: readonly ApprovalReason[];
  threadId: string;
}) {
  if (reasons.length === 0) return null;

  return <SettingRows reasons={reasons} threadId={threadId} />;
}

function SettingRows({
  reasons,
  threadId,
}: {
  reasons: readonly ApprovalReason[];
  threadId: string;
}) {
  const navigate = useNavigate();
  // Null before the first pull, and on a shared page with no sync: then no row shows.
  const { policy } = useActionPolicy();
  const settings = policy === null ? [] : settingsOf(reasons, policy);
  // Undefined on a shared page with no sync and no picker, so the button does not show there.
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
          scope={link.scope}
          onClick={() =>
            void (link.slug === undefined
              ? navigate({ to: "/integrations" })
              : navigate({ to: "/integrations/$slug", params: { slug: link.slug } }))
          }
        />
      ))}
      {offersFullAutonomy ? (
        <SettingButton
          label={APPROVAL_CONTROL_LABELS.fullAutonomyButton}
          onClick={() => requestApprovalModePicker(threadId)}
        />
      ) : null}
    </div>
  );
}

function SettingButton({
  label,
  scope,
  onClick,
}: {
  label: string;
  /** Omitted when the label already names the scope. */
  scope?: string | undefined;
  onClick: () => void;
}) {
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
      {scope === undefined ? null : <span className="font-normal text-app-fg-2">· {scope}</span>}
      <ArrowRight
        size={13}
        aria-hidden
        className="transition-transform duration-200 group-hover/setting:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}
