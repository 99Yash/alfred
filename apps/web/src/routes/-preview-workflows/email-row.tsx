import { cn } from "~/lib/utils";

export function EmailRow({
  className,
  highlight,
  accent,
}: {
  className?: string;
  highlight?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={cn(
        "h-[34px] rounded-lg bg-vs-bg-2 px-2.5 flex items-center gap-2",
        "shadow-[var(--vs-shadow-elevated)] absolute inset-x-0",
        highlight && cn("bg-vs-bg-1", accent),
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", highlight ? accent : "bg-vs-fg-2")} aria-hidden style={highlight ? { backgroundColor: "currentColor" } : undefined} />
      <span className="flex-1">
        <span className={cn("block h-1.5 w-[60%] rounded-full", highlight ? "bg-vs-fg-3" : "bg-vs-fg-2/40")} />
        <span className="block h-1 w-[40%] rounded-full bg-vs-fg-2/25 mt-1" />
      </span>
    </div>
  );
}
