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
import { Check, ChevronDown, Sparkles, Telescope } from "lucide-react";
import { use, useId, type ComponentType } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";

export type ChatTier = ChatModelTier;

interface TierOption {
  value: ChatTier;
  label: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

const STANDARD_OPTION: TierOption = {
  value: "standard",
  label: "Auto",
  description: "Fast and capable for everyday questions",
  icon: Sparkles,
};
const DEEP_OPTION: TierOption = {
  value: "deep",
  label: "Deep",
  description: "Slower, deeper reasoning for complex tasks",
  icon: Telescope,
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
  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;
  const selected = value === "deep" ? DEEP_OPTION : STANDARD_OPTION;
  const SelectedIcon = selected.icon;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          title="Choose how hard Alfred thinks"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2 text-[12px]",
            "text-app-fg-3 transition-colors app-press outline-none",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
            "data-[state=open]:bg-app-bg-a2 data-[state=open]:text-app-fg-4",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <SelectedIcon size={12} className="shrink-0" />
          {selected.label}
          <ChevronDown size={12} className="shrink-0 text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
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
            "app app-frost-overlay z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl p-1.5",
            "outline-none app-fade-in",
          )}
        >
          {TIER_OPTIONS.map((option) => {
            const Icon = option.icon;
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => onChange(option.value)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left outline-none transition-colors",
                  "hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2",
                )}
              >
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-app-bg-2 text-app-fg-3">
                  <Icon size={13} />
                </span>
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
