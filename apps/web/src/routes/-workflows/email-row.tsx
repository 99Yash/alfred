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
        "flex h-[34px] items-center gap-2 rounded-lg bg-app-bg-2 px-2.5",
        "absolute inset-x-0 shadow-(--app-shadow-elevated)",
        highlight && cn("bg-app-bg-1", accent),
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", highlight ? accent : "bg-app-fg-2")}
        aria-hidden
        style={highlight ? { backgroundColor: "currentColor" } : undefined}
      />
      <span className="flex-1">
        <span
          className={cn(
            "block h-1.5 w-[60%] rounded-full",
            highlight ? "bg-app-fg-3" : "bg-app-fg-2/40",
          )}
        />
        <span className="mt-1 block h-1 w-[40%] rounded-full bg-app-fg-2/25" />
      </span>
    </div>
  );
}
