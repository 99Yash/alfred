/**
 * Trigger classes for the composer pickers in `picker-menu.tsx`.
 * Not in the component file, which would lose Fast Refresh.
 */
import { cn } from "~/lib/utils";

/** Pill trigger base. The caller adds the fill; `group` lets `PickerChevron` read the open state. */
export const pickerTriggerClass = cn(
  "group inline-flex h-7 items-center gap-1.5 rounded-control-sm px-2 text-[12px] font-medium",
  "app-press transition-[box-shadow,color,background-color,scale] outline-none",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "app-focus",
);

/** The neutral pill fill. */
export const pickerTriggerNeutralClass = cn(
  "bg-linear-to-b from-app-bg-1 to-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
  "enabled:hover:text-app-fg-4 enabled:hover:shadow-(--app-shadow-elevated-hover)",
  "data-[state=open]:text-app-fg-4 data-[state=open]:shadow-(--app-shadow-elevated-hover)",
);
