/**
 * App-grammar Select primitive.
 *
 * A styled single-select that replaces the native `<select>` — same h-9
 * pill chrome as `AppInput`, opening a popover list of options with the
 * selected row checked. Built on `@radix-ui/react-popover` (the project's
 * established menu primitive; we don't pull in `@radix-ui/react-select`)
 * so it gets portalled positioning, outside-click + Escape dismissal, and
 * focus management for free.
 *
 * Keyboard: the trigger is a button (Space/Enter opens). Options are real
 * buttons inside the content, so Tab/Shift-Tab + Enter select. Good enough
 * for the short, bounded option lists these schemas produce.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface AppSelectOption {
  value: string;
  label: string;
}

interface AppSelectProps {
  id?: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: ReadonlyArray<AppSelectOption>;
  /** Adds a leading "clear" row that resolves to `undefined`. */
  clearable?: boolean;
  /** Label for the clear row + empty trigger state. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Optional leading glyph shown in the trigger. */
  leading?: ReactNode;
}

export function AppSelect({
  id,
  value,
  onChange,
  options,
  clearable = false,
  placeholder = "Select…",
  disabled,
  className,
  leading,
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  const select = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left text-sm",
            "bg-app-bg-1 text-app-fg-4 app-elevated app-press",
            "outline-none transition-shadow",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
            "data-[state=open]:ring-2 data-[state=open]:ring-app-purple-2 data-[state=open]:ring-offset-4 data-[state=open]:ring-offset-app-background",
            "disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
        >
          {leading ? <span className="inline-flex shrink-0 text-app-fg-2">{leading}</span> : null}
          <span className={cn("min-w-0 flex-1 truncate", selected ? undefined : "text-app-fg-2")}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className={cn(
            "z-50 max-h-72 w-[var(--radix-popover-trigger-width)] min-w-44 overflow-auto rounded-2xl bg-app-bg-1 p-1.5",
            "shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none app-fade-in",
          )}
        >
          {clearable ? (
            <Row checked={value === undefined} onSelect={() => select(undefined)} muted>
              {placeholder}
            </Row>
          ) : null}
          {options.map((option) => (
            <Row
              key={option.value}
              checked={option.value === value}
              onSelect={() => select(option.value)}
            >
              {option.label}
            </Row>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Row({
  checked,
  muted,
  onSelect,
  children,
}: {
  checked: boolean;
  muted?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors",
        "hover:bg-app-bg-a1 hover:text-app-fg-4 focus-visible:bg-app-bg-a1 focus-visible:text-app-fg-4",
        checked ? "text-app-fg-4" : muted ? "text-app-fg-2" : "text-app-fg-3",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked ? <Check size={14} className="shrink-0 text-app-purple-4" /> : null}
    </button>
  );
}
