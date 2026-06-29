/**
 * Chat model-tier picker — the functional successor to the composer's old
 * disabled "Auto" pill. Mirrors dimension's agent-mode picker (a model
 * selector, not the autonomy toggle): a compact pill trigger opening a frosted
 * popover of label + description rows. The choice rides with each turn as
 * `tier`, which the server maps through `getChatModel` (standard → the fast
 * everyday model, deep → the deeper-reasoning escalation).
 *
 * `ChatTier` aliases the canonical `ChatModelTier` from `@alfred/contracts`.
 * (Server-side the runtime mapping lives in `@alfred/ai` (`getChatModel`), a
 * server-only package that must never enter the web runtime bundle — see
 * `pnpm check:web-boundaries` — so the shared source of truth is the tier
 * literal in `@alfred/contracts`, importable from both sides, which keeps the
 * two from drifting.)
 */
import type { ChatModelTier } from "@alfred/contracts";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { use, useId } from "react";
import { AppThemeContext, type AppResolvedTheme } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export type ChatTier = ChatModelTier;

// Per-tier, theme-tuned Alfred marks. Like dimension's agent-mode picker, each
// tier carries its OWN glyph — Standard is the calm single-capsule mark, Pro
// nests a second capsule inside and lifts the gradient — so the two read as
// distinct at a glance, not just by their label. Each tier then has a light/dark
// variant (vivid + dark rim on light surfaces, calmer + light rim on dark). See
// public/images/logo/alfred-logo{,-pro}-{light,dark}.svg.
const TIER_MARK: Record<ChatTier, Record<AppResolvedTheme, string>> = {
  standard: {
    light: "/images/logo/alfred-logo-light.svg",
    dark: "/images/logo/alfred-logo-dark.svg",
  },
  deep: {
    light: "/images/logo/alfred-logo-pro-light.svg",
    dark: "/images/logo/alfred-logo-pro-dark.svg",
  },
};

interface TierOption {
  value: ChatTier;
  label: string;
  description: string;
}

const STANDARD_OPTION: TierOption = {
  value: "standard",
  label: "Alfred",
  description: "Great for almost everything",
};
const DEEP_OPTION: TierOption = {
  value: "deep",
  label: "Alfred Pro",
  description: "Flagship reasoning for complex tasks",
};
const TIER_OPTIONS: ReadonlyArray<TierOption> = [STANDARD_OPTION, DEEP_OPTION];

export function ModelTierPicker({
  value,
  onChange,
  disabled,
}: {
  value: ChatTier;
  onChange: (value: ChatTier) => void;
  disabled?: boolean;
}) {
  const listboxId = useId();
  // The popover portals out of the `.app` subtree, so CSS token inheritance
  // breaks — stamp the resolved theme on the content directly (React context
  // still flows through portals). Same pattern as `AppSelect`.
  const themeCtx = use(AppThemeContext);
  const resolved: AppResolvedTheme = themeCtx?.resolved ?? "dark";
  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;
  const selected = value === "deep" ? DEEP_OPTION : STANDARD_OPTION;

  return (
    <PopoverPrimitive.Root>
      <Tip label="Choose how hard Alfred thinks">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2 text-[12px]",
              "app-press text-app-fg-3 outline-none",
              "transition-[box-shadow,color,background-color]",
              // Raised frosted pill — visible chrome at rest, mirrors dimension's mode pill.
              "bg-gradient-to-b from-app-bg-1 to-app-bg-2 shadow-(--app-shadow-elevated)",
              "hover:text-app-fg-4 hover:shadow-(--app-shadow-elevated-hover)",
              "data-[state=open]:text-app-fg-4 data-[state=open]:shadow-(--app-shadow-elevated-hover)",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
            )}
          >
            <img
              src={TIER_MARK[selected.value][resolved]}
              alt=""
              className="size-[18px] shrink-0"
            />
            {selected.label}
            <ChevronDown size={12} className="shrink-0 text-app-fg-2" />
          </button>
        </PopoverPrimitive.Trigger>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={listboxId}
          role="listbox"
          aria-label="Model tier"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={dataTheme}
          className={cn(
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-hidden rounded-2xl p-1.5",
            "app-fade-in outline-none",
          )}
        >
          {TIER_OPTIONS.map((option) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => onChange(option.value)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl p-2 text-left transition-colors outline-none",
                  "hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2",
                  // Selected row holds a quiet tint so the active tier reads even
                  // before the eye finds the check.
                  checked && "bg-app-bg-a2",
                )}
              >
                <img
                  src={TIER_MARK[option.value][resolved]}
                  alt=""
                  className="mt-0.5 size-7 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-app-fg-4">
                    {option.label}
                  </span>
                  <span className="block text-[11.5px] leading-snug text-app-fg-2">
                    {option.description}
                  </span>
                </span>
                {checked ? <Check size={14} className="mt-0.5 shrink-0 text-app-purple-4" /> : null}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
