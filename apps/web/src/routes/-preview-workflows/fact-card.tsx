import { cn } from "~/lib/utils";

export function FactCard({
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
        "absolute w-[60%] h-[52px] rounded-lg px-3 py-2",
        "shadow-[var(--app-shadow-elevated)] flex flex-col gap-1.5 justify-center",
        highlight ? cn("bg-app-bg-1", accent) : "bg-app-bg-2",
        className,
      )}
    >
      <span
        className={cn("block h-1.5 w-[70%] rounded-full", highlight ? accent : "bg-app-fg-2/40")}
        style={highlight ? { backgroundColor: "currentColor" } : undefined}
      />
      <span className="block h-1 w-[40%] rounded-full bg-app-fg-2/25" />
    </div>
  );
}
