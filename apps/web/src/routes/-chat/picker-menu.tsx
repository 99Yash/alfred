/**
 * The composer's picker menu, shared by {@link ModelTierPicker} and {@link ApprovalModePicker}.
 * A Radix radio menu, so arrow keys, Home/End, and typeahead move between options.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export function PickerChevron({ className }: { className?: string | undefined }) {
  return (
    <ChevronDown
      size={12}
      aria-hidden
      className={cn(
        "shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180",
        className ?? "text-app-fg-2",
      )}
    />
  );
}

export function PickerMenu({
  label,
  heading,
  value,
  tip,
  tipDescription,
  trigger,
  children,
}: {
  /** The menu's accessible name. */
  label: string;
  /** Optional line above the options. */
  heading?: string | undefined;
  /** The `value` of the checked {@link PickerMenuItem}. */
  value: string;
  tip: string;
  tipDescription?: string | undefined;
  /** A button. Radix adds `data-state` and the ARIA attributes. */
  trigger: ReactElement;
  children: ReactNode;
}) {
  // The menu portals out of `.app`, so stamp the resolved theme on the content.
  const { resolved } = useAppTheme();

  return (
    <DropdownMenu.Root>
      <Tip label={tip} description={tipDescription}>
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={label}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          loop
          data-app-theme={resolved}
          className={cn(
            "app app-frost-overlay app-frost-edge relative z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-hidden rounded-surface p-1",
            // Grow out of the trigger, not out of the menu's bottom center.
            "origin-(--radix-dropdown-menu-content-transform-origin) outline-none",
            "motion-safe:data-[state=open]:animate-[app-popover-in_180ms_cubic-bezier(0.22,1,0.36,1)]",
            "motion-safe:data-[state=closed]:animate-[app-popover-out_120ms_cubic-bezier(0.22,1,0.36,1)]",
          )}
        >
          {heading ? (
            <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-app-fg-2 select-none">
              {heading}
            </DropdownMenu.Label>
          ) : null}
          <DropdownMenu.RadioGroup value={value}>{children}</DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function PickerMenuItem({
  value,
  label,
  description,
  icon,
  onSelect,
}: {
  value: string;
  label: string;
  description: string;
  /** A 28px mark. */
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      onSelect={onSelect}
      className={cn(
        // Concentric with the menu: `rounded-control` (14px) plus the menu's `p-1` is `rounded-surface` (18px).
        "app-press flex w-full cursor-default items-start gap-2.5 rounded-control p-2 text-left outline-none select-none",
        "transition-[background-color,scale]",
        // Checked is a step stronger than highlighted, so a highlight never looks checked.
        "data-[state=checked]:bg-app-bg-a3 data-[state=unchecked]:data-highlighted:bg-app-bg-a2",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-app-fg-4">{label}</span>
        <span className="block text-[11.5px] leading-snug text-pretty text-app-fg-2">
          {description}
        </span>
      </span>
      <DropdownMenu.ItemIndicator className="mt-0.5 shrink-0">
        <Check size={14} className="text-app-purple-4" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}
