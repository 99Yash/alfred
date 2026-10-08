/**
 * Approval-mode picker, same shape as {@link ModelTierPicker}.
 * `user_action_policies.defaultMode` is `gated` or `autonomy`, a global switch; Settings rules override it.
 * Stays usable while a pending approval disables the composer, so Autopilot can release a parked run.
 */
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { use, useId, useState } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import { MODE_OPTIONS, modeOption } from "./approval-mode-options";
import { Tip } from "./tip";

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
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  // The popover portals out of `.app`, so stamp the theme on the content.
  const themeCtx = use(AppThemeContext);

  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;

  const selected = modeOption(on);
  const SelectedIcon = selected.Icon;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tip
        label="Action approval"
        description={on ? "Autopilot: Alfred acts freely." : "Review: Alfred asks before acting."}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2 text-[12px] font-medium",
              "app-press transition-[box-shadow,color,background-color] outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "app-focus",
              on
                ? cn(
                    // Autopilot: lit green pill.
                    "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]",
                    "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-green-3)_28%,transparent)_0%,transparent_68%),var(--app-green-1)]",
                  )
                : cn(
                    // Review: neutral pill, like the model pill.
                    "bg-linear-to-b from-app-bg-1 to-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
                    "enabled:hover:text-app-fg-4 enabled:hover:shadow-(--app-shadow-elevated-hover)",
                    "data-[state=open]:text-app-fg-4 data-[state=open]:shadow-(--app-shadow-elevated-hover)",
                  ),
            )}
          >
            <SelectedIcon size={12} className="shrink-0" />
            {selected.label}
            <ChevronDown
              size={12}
              className={cn(
                "shrink-0 transition-transform duration-200",
                on ? "text-app-green-4/70" : "text-app-fg-2",
                open && "rotate-180",
              )}
            />
          </button>
        </PopoverPrimitive.Trigger>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={listboxId}
          role="listbox"
          aria-label="Action approval"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={dataTheme}
          className={cn(
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-hidden rounded-2xl p-1.5",
            "origin-bottom outline-none",
            "motion-safe:data-[state=open]:animate-[app-popover-in_180ms_cubic-bezier(0.22,1,0.36,1)]",
            "motion-safe:data-[state=closed]:animate-[app-popover-out_120ms_cubic-bezier(0.22,1,0.36,1)]",
          )}
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-app-fg-2">
            How should Alfred act?
          </p>
          {MODE_OPTIONS.map((option) => {
            const checked = option.autonomy === on;
            const OptionIcon = option.Icon;

            return (
              <PopoverPrimitive.Close asChild key={option.label}>
                <button
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => {
                    if (!checked) onToggle();
                  }}
                  className={cn(
                    "app-press flex w-full items-start gap-2.5 rounded-xl p-2 text-left transition-colors outline-none",
                    "hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2",
                    "active:bg-app-bg-a3",
                    // Selected is a step stronger than hover, so hover never looks selected.
                    checked && "bg-app-bg-a3",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
                      option.autonomy
                        ? "bg-app-green-1 text-app-green-4"
                        : "bg-app-bg-2 text-app-fg-3",
                    )}
                  >
                    <OptionIcon size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-app-fg-4">
                      {option.label}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-app-fg-2">
                      {option.description}
                    </span>
                  </span>
                  {checked ? (
                    <Check size={14} className="mt-0.5 shrink-0 text-app-purple-4" />
                  ) : null}
                </button>
              </PopoverPrimitive.Close>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
