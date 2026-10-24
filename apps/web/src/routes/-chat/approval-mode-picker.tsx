/**
 * Approval-mode picker, same shape as {@link ModelTierPicker}. See {@link ChatApprovalMode} for
 * what each mode writes. Stays usable while a pending approval disables the composer, so a mode
 * change can apply to the parked run's next call.
 */
import { cn } from "~/lib/utils";
import { MODE_OPTIONS, modeOption } from "./approval-mode-options";
import type { ChatApprovalMode } from "@alfred/sync";
import { PickerChevron, PickerMenu, PickerMenuItem } from "./picker-menu";
import { pickerTriggerClass, pickerTriggerNeutralClass } from "./picker-menu-classes";

const TIP_DESCRIPTION = {
  review: "Review: Alfred asks before acting.",
  auto: "Auto: Alfred follows your rules. Risky actions still ask.",
  full: "Full autonomy: this chat never asks.",
} satisfies Record<ChatApprovalMode, string>;

function triggerToneClass(mode: ChatApprovalMode): string {
  if (mode === "full") {
    // Full autonomy: a red pill, so the dangerous mode is never missed.
    return cn(
      "text-app-red-4 shadow-[0_0_0_1px_var(--app-red-2)]",
      "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-red-3)_28%,transparent)_0%,transparent_68%),var(--app-red-1)]",
    );
  }

  if (mode === "auto") {
    // Auto: lit green pill.
    return cn(
      "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]",
      "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-green-3)_28%,transparent)_0%,transparent_68%),var(--app-green-1)]",
    );
  }

  return pickerTriggerNeutralClass;
}

function optionIconClass(mode: ChatApprovalMode): string {
  if (mode === "full") return "bg-app-red-1 text-app-red-4";

  return mode === "auto" ? "bg-app-green-1 text-app-green-4" : "bg-app-bg-2 text-app-fg-3";
}

function chevronClass(mode: ChatApprovalMode): string | undefined {
  if (mode === "full") return "text-app-red-4/70";

  return mode === "auto" ? "text-app-green-4/70" : undefined;
}

export function ApprovalModePicker({
  mode,
  disabled,
  onChange,
}: {
  mode: ChatApprovalMode;
  disabled?: boolean | undefined;
  onChange: (mode: ChatApprovalMode) => void;
}) {
  const selected = modeOption(mode);
  const SelectedIcon = selected.Icon;

  return (
    <PickerMenu
      label="Action approval"
      heading="How should Alfred act?"
      value={mode}
      tip="Action approval"
      tipDescription={TIP_DESCRIPTION[mode]}
      trigger={
        <button
          type="button"
          disabled={disabled}
          className={cn(pickerTriggerClass, triggerToneClass(mode))}
        >
          <SelectedIcon size={12} className="shrink-0" />
          {selected.label}
          <PickerChevron className={chevronClass(mode)} />
        </button>
      }
    >
      {MODE_OPTIONS.map((option) => {
        const OptionIcon = option.Icon;

        return (
          <PickerMenuItem
            key={option.value}
            value={option.value}
            label={option.label}
            description={option.description}
            icon={
              <span
                className={cn(
                  "mt-0.5 grid size-7 shrink-0 place-items-center rounded-control-xs",
                  optionIconClass(option.value),
                )}
              >
                <OptionIcon size={15} />
              </span>
            }
            onSelect={() => {
              if (!disabled && option.value !== mode) onChange(option.value);
            }}
          />
        );
      })}
    </PickerMenu>
  );
}
