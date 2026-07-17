/**
 * Chat action-approval picker — the successor to the composer's binary
 * "Review / Autopilot" badge. Mirrors the {@link ModelTierPicker} shape (a
 * compact pill trigger opening a frosted popover of icon + label + description
 * rows), so the composer's two controls read as siblings rather than a picker
 * next to a toggle.
 *
 * Alfred's approval model is binary — `user_action_policies.defaultMode` is
 * either `gated` (pause for approval) or `autonomy` (act freely) — so there are
 * two rows, not ChatGPT's three. This is a *global* switch: it governs triage,
 * briefing and workflows too, and per-integration rules in Settings still
 * override it. The trigger stays interactive while the composer is disabled by a
 * pending approval, so flipping to Autopilot lets a parked run continue.
 */
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown, ShieldCheck, Zap } from "lucide-react";
import { use, useId, type ComponentType } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

interface ModeOption {
  /** True = autonomy (Autopilot); false = gated (Review). */
  autonomy: boolean;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number | string; className?: string }>;
}

const REVIEW_OPTION: ModeOption = {
  autonomy: false,
  label: "Review",
  description: "Alfred pauses for your approval before acting.",
  Icon: ShieldCheck,
};
const AUTOPILOT_OPTION: ModeOption = {
  autonomy: true,
  label: "Autopilot",
  description: "Alfred acts without pausing for approval.",
  Icon: Zap,
};
const MODE_OPTIONS: ReadonlyArray<ModeOption> = [REVIEW_OPTION, AUTOPILOT_OPTION];

export function ApprovalModePicker({
  on,
  disabled,
  onToggle,
}: {
  /** True when Autopilot (autonomy) is active. */
  on: boolean;
  disabled?: boolean;
  /** Flip the mode. There are only two, so selecting the other one is a toggle. */
  onToggle: () => void;
}) {
  const listboxId = useId();
  // The popover portals out of the `.app` subtree, so stamp the resolved theme
  // on the content directly (context still flows through the portal). Same
  // pattern as ModelTierPicker / AppSelect.
  const themeCtx = use(AppThemeContext);
  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;
  const selected = on ? AUTOPILOT_OPTION : REVIEW_OPTION;
  const SelectedIcon = selected.Icon;

  return (
    <PopoverPrimitive.Root>
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
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
              on
                ? cn(
                    // Autopilot on — the lit green pill carries the "acting
                    // freely" signal, same language as the integrations policy
                    // card and the old toggle.
                    "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]",
                    "[background:radial-gradient(130%_140%_at_18%_120%,color-mix(in_srgb,var(--app-green-3)_28%,transparent)_0%,transparent_68%),var(--app-green-1)]",
                  )
                : cn(
                    // Review — neutral raised frosted pill, matching the model pill.
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
              className={cn("shrink-0", on ? "text-app-green-4/70" : "text-app-fg-2")}
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
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl p-1.5",
            "app-fade-in outline-none",
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
                    "flex w-full items-start gap-2.5 rounded-xl p-2 text-left transition-colors outline-none",
                    "hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2",
                    checked && "bg-app-bg-a2",
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
