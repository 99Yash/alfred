import {
  approvalSettings,
  APPROVAL_CONTROL_LABELS,
  humanizeToolName,
  INTEGRATION_DISPLAY_NAMES,
  integrationFromToolName,
  resolveToolModeDecision,
} from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ArrowRight, ChevronDown, ShieldCheck } from "lucide-react";
import { use, useId, useRef } from "react";
import { AppSwitch } from "~/components/ui/v2";
import { AppThemeContext } from "~/components/ui/v2/theme";
import type { ActionPolicyState } from "~/lib/replicache/use-action-policy";
import { cn } from "~/lib/utils";

export type PermissionsPolicy = Pick<
  ActionPolicyState,
  "policy" | "modeFor" | "setIntegrationMode" | "setToolMode"
>;

/**
 * The "Permissions" menu in the head of a card that waits: each setting that removes such a card,
 * with its scope (ADR-0130 amendment (c)). The settings come from the row's reason and current
 * policy. A row with no reason, or no synced policy yet, shows no menu. Policy writes are
 * optimistic. The row keeps its decision, so this card still needs Approve.
 */
export function PermissionsMenu({
  staging,
  policy,
  onFullAutonomy,
  onError,
}: {
  staging: SyncedActionStaging;
  policy: PermissionsPolicy;
  /**
   * Opens the approval mode picker of the row's chat thread (ADR-0069). `undefined` when the row
   * has no thread (a workflow run), so Full Autonomy does not apply.
   */
  onFullAutonomy: (() => void) | undefined;
  /** A failed policy write, or `null` when a new write starts. */
  onError: (message: string | null) => void;
}) {
  const popoverId = useId();
  // Full Autonomy opens the picker as the popover closes. The popover then must not take the
  // focus back to its trigger, or the picker closes at once.
  const openingPicker = useRef(false);
  // The popover portals out of `.app`, so stamp the resolved theme on the content.
  const dataTheme = use(AppThemeContext)?.resolved;
  const synced = policy.policy;

  if (staging.approvalReason === null || synced === null) return null;

  const settings = approvalSettings(staging.approvalReason, synced, onFullAutonomy !== undefined);

  if (settings.length === 0) return null;

  const integrationSetting = settings.find((setting) => setting.kind === "integration_mode");
  const showTool = settings.some((setting) => setting.kind === "always_allow");
  const showFullAutonomy = settings.some((setting) => setting.kind === "full_autonomy");
  const toolTitle = humanizeToolName(staging.toolName);

  const toolIntegrationName = INTEGRATION_DISPLAY_NAMES[integrationFromToolName(staging.toolName)];

  // On only for the tool's own "Always allow" override, not for a mode it inherits.
  const toolMode = resolveToolModeDecision(
    synced.integrationRules,
    staging.toolName,
    synced.defaultMode,
  );

  const toolAllowed = toolMode.source === "tool_override" && toolMode.mode === "autonomy";

  const integrationName =
    integrationSetting === undefined
      ? undefined
      : INTEGRATION_DISPLAY_NAMES[integrationSetting.integration];

  const integrationAllowed =
    integrationSetting !== undefined &&
    policy.modeFor(integrationSetting.integration) === "autonomy";

  const write = (pending: Promise<void>) => {
    onError(null);
    pending.catch((err: unknown) => {
      onError(err instanceof Error ? err.message : "Failed to update policy");
    });
  };

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-controls={popoverId}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-control-sm px-2 text-[12px] font-medium text-app-fg-3",
            "app-focus app-press transition-[box-shadow,color,background-color]",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
          )}
        >
          <ShieldCheck size={12} aria-hidden className="shrink-0" />
          {/* Hidden on a narrow screen, but still the button's accessible name. */}
          <span className="sr-only sm:not-sr-only">{APPROVAL_CONTROL_LABELS.permissions}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0 text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={popoverId}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={dataTheme}
          onCloseAutoFocus={(event) => {
            if (!openingPicker.current) return;
            openingPicker.current = false;
            event.preventDefault();
          }}
          className={cn(
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-surface p-3",
            "app-fade-in outline-none",
          )}
        >
          <p className="text-[11px] font-medium tracking-tight text-app-fg-2">
            Default permissions
          </p>
          {showTool ? (
            <PermissionSwitch
              id={`permissions-tool-${staging.id}`}
              checked={toolAllowed}
              // Off removes the override, so the integration mode governs the tool again.
              onCheckedChange={(next) =>
                write(policy.setToolMode(staging.toolName, next ? "autonomy" : null))
              }
              label={APPROVAL_CONTROL_LABELS.alwaysAllowAction}
              hint={
                toolAllowed
                  ? `Only ${toolTitle}: Alfred does it without asking.`
                  : `Only ${toolTitle}. Other ${toolIntegrationName} actions keep their rule.`
              }
            />
          ) : null}
          {integrationSetting !== undefined && integrationName !== undefined ? (
            <PermissionSwitch
              id={`permissions-integration-${staging.id}`}
              checked={integrationAllowed}
              onCheckedChange={(next) =>
                write(
                  policy.setIntegrationMode(
                    integrationSetting.integration,
                    next ? "autonomy" : "gated",
                  ),
                )
              }
              label={`Always allow ${integrationName}`}
              hint={
                integrationAllowed
                  ? `Alfred acts without asking for ${integrationName}. High-risk actions still ask.`
                  : `Every ${integrationName} action, except high-risk ones.`
              }
            />
          ) : null}
          {showFullAutonomy && onFullAutonomy !== undefined ? (
            <div className="min-w-0">
              <PopoverPrimitive.Close asChild>
                <button
                  type="button"
                  onClick={() => {
                    openingPicker.current = true;
                    onFullAutonomy();
                  }}
                  className={cn(
                    "group/full inline-flex items-center gap-1 rounded-control-xs text-[13px] leading-5 font-medium text-app-fg-4",
                    "app-focus",
                  )}
                >
                  {APPROVAL_CONTROL_LABELS.fullAutonomyButton}
                  <ArrowRight
                    size={13}
                    aria-hidden
                    className="transition-transform duration-200 group-hover/full:translate-x-0.5 motion-reduce:transition-none"
                  />
                </button>
              </PopoverPrimitive.Close>
              <p className="mt-0.5 text-[11.5px] leading-snug text-app-fg-2">
                Each approval card in this chat, high-risk ones too. Opens the mode menu.
              </p>
            </div>
          ) : null}
          <p className="text-[11.5px] leading-snug text-app-fg-2">
            Applies from Alfred's next action. This one still needs your approval.
          </p>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function PermissionSwitch({
  id,
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <AppSwitch
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] leading-5 font-medium text-app-fg-4">
          {label}
        </label>
        <p className="mt-0.5 text-[11.5px] leading-snug text-app-fg-2">{hint}</p>
      </div>
    </div>
  );
}
