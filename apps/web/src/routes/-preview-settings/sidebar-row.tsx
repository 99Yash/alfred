import { cn } from "~/lib/utils";
import type { SectionDef } from "./helpers";

export function SidebarRow({
  section,
  active,
  onClick,
}: {
  section: SectionDef;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative inline-flex w-full items-center gap-2.5 rounded-xl",
        "h-9 px-3 text-sm font-medium whitespace-nowrap",
        "transition-[background-color,color] duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        "app-press",
        active ? "bg-app-bg-2 text-app-fg-4" : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-2 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-app-purple-4"
        />
      )}
      <Icon
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-150",
          active ? "text-app-fg-4" : "text-app-fg-2 group-hover:text-app-fg-4",
        )}
      />
      <span>{section.label}</span>
    </button>
  );
}
