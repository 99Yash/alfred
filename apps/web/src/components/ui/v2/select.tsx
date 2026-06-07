/**
 * App-grammar Select primitive.
 *
 * A styled single-select that replaces the native `<select>` — same h-9 pill
 * chrome as `AppInput`, opening a popover listbox with the selected row
 * checked. Built on `@radix-ui/react-popover` for positioning/dismissal, with
 * the listbox semantics + roving arrow-key focus implemented here.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  /** Accessible label for the popover listbox. */
  label?: string;
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
  label,
  leading,
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value);
  const rows = useMemo(
    () => [
      ...(clearable ? [{ value: undefined, label: placeholder, muted: true }] : []),
      ...options.map((option) => ({ ...option, muted: false })),
    ],
    [clearable, options, placeholder],
  );

  const select = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };

  const focusRow = (index: number) => {
    const next = rowRefs.current[index];
    if (next) next.focus();
  };

  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.value === value),
  );

  const moveFocus = (delta: number) => {
    const active = document.activeElement;
    const current = rowRefs.current.findIndex((row) => row === active);
    const from = current >= 0 ? current : selectedIndex;
    focusRow((from + delta + rows.length) % rows.length);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpen(true);
          }}
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
          id={listboxId}
          role="listbox"
          aria-label={label ?? placeholder}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            queueMicrotask(() => focusRow(selectedIndex));
          }}
          onKeyDown={handleListKeyDown}
          className={cn(
            "z-50 max-h-72 w-[var(--radix-popover-trigger-width)] min-w-44 overflow-auto rounded-2xl bg-app-bg-1 p-1.5",
            "shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none app-fade-in",
          )}
        >
          {rows.map((option, index) => (
            <Row
              key={option.value ?? "__clear__"}
              buttonRef={(node) => {
                rowRefs.current[index] = node;
              }}
              checked={option.value === value}
              muted={option.muted}
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
  buttonRef,
  checked,
  muted,
  onSelect,
  children,
}: {
  buttonRef: (node: HTMLButtonElement | null) => void;
  checked: boolean;
  muted?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="option"
      aria-selected={checked}
      tabIndex={-1}
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
