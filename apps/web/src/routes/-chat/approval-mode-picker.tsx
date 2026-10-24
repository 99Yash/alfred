/**
 * Approval-mode picker, same shape as {@link ModelTierPicker}.
 * `user_action_policies.defaultMode` is `gated` or `autonomy`, a global switch; Settings rules override it.
 * Stays usable while a pending approval disables the composer, so Autopilot can release a parked run.
 */
import { cn } from "~/lib/utils";
import { MODE_OPTIONS, modeOption } from "./approval-mode-options";
import { PickerChevron, PickerMenu, PickerMenuItem } from "./picker-menu";
import { pickerTriggerClass, pickerTriggerNeutralClass } from "./picker-menu-classes";

const modeValue = (autonomy: boolean) => (autonomy ? "autopilot" : "review");

export function ApprovalModePicker({
  on,
  disabled,
  onToggle,
}: {
  /** Autopilot (autonomy) is on. */
  on: boolean;
  disabled?: boolean | undefined;
  /** Two modes, so selecting the other one toggles. */
  onToggle: () => void;
}) {
  const selected = modeOption(on);
  const SelectedIcon = selected.Icon;

  return (
    <PickerMenu
      label="Action approval"
      heading="How should Alfred act?"
      value={modeValue(on)}
      tip="Action approval"
      tipDescription={on ? "Autopilot: Alfred acts freely." : "Review: Alfred asks before acting."}
      trigger={
        <button
          type="button"
          disabled={disabled}
          className={cn(
            pickerTriggerClass,
            on
              ? cn(
                  // Autopilot: lit green pill.
                  "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]",
                  "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-green-3)_28%,transparent)_0%,transparent_68%),var(--app-green-1)]",
                )
              : pickerTriggerNeutralClass,
          )}
        >
          <SelectedIcon size={12} className="shrink-0" />
          {selected.label}
          <PickerChevron className={on ? "text-app-green-4/70" : undefined} />
        </button>
      }
    >
      {MODE_OPTIONS.map((option) => {
        const OptionIcon = option.Icon;

        return (
          <PickerMenuItem
            key={option.label}
            value={modeValue(option.autonomy)}
            label={option.label}
            description={option.description}
            icon={
              <span
                className={cn(
                  "mt-0.5 grid size-7 shrink-0 place-items-center rounded-control-xs",
                  option.autonomy ? "bg-app-green-1 text-app-green-4" : "bg-app-bg-2 text-app-fg-3",
                )}
              >
                <OptionIcon size={15} />
              </span>
            }
            onSelect={() => {
              if (option.autonomy !== on) onToggle();
            }}
          />
        );
      })}
    </PickerMenu>
  );
}
