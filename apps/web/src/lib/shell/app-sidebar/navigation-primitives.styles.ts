import { cn } from "~/lib/utils";

export const railIconClass = (active = false) =>
  cn(
    "relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl",
    "app-press transition-[background-color,color] duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
    active
      ? "sidebar-tile text-app-fg-4"
      : "text-app-fg-2 hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-[inset_0_1px_0_var(--app-sidebar-tile-highlight)]",
  );
