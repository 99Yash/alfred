import { cn } from "~/lib/utils";

/** Radix dropdown and context menu surface. The caller adds its `min-w-*`. */
export const appMenuSurfaceClass = cn(
  "app z-200 rounded-surface p-1",
  "border border-app-bg-3/70 bg-app-bg-1",
  "shadow-[0_8px_28px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.04)]",
  "data-[state=open]:animate-[app-fade-in_120ms_ease-out]",
);

export const appMenuItemClass = cn(
  "flex h-8 cursor-default items-center gap-2.5 rounded-control px-2 text-sm font-medium select-none",
  "text-app-fg-3 outline-none",
  "data-[highlighted]:bg-app-bg-a2 data-[highlighted]:text-app-fg-4",
  "data-[disabled]:opacity-50",
);

/** A destructive item, such as Delete or Remove. */
export const appMenuDangerItemClass = cn(
  appMenuItemClass,
  "text-app-red-4 data-highlighted:bg-app-red-1 data-highlighted:text-app-red-4",
);

export const appMenuSeparatorClass = "my-1 h-px bg-app-bg-3/70";
