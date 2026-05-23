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
        "group inline-flex w-full items-center gap-2.5 rounded-xl",
        "h-9 px-3 text-sm font-medium whitespace-nowrap",
        "transition-[background-color,color] duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        "vs-press",
        active ? "bg-vs-bg-2 text-vs-fg-4" : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      <Icon
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-150",
          active ? "text-vs-fg-4" : "text-vs-fg-2 group-hover:text-vs-fg-4",
        )}
      />
      <span>{section.label}</span>
    </button>
  );
}
