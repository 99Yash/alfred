import { cn } from "~/lib/utils";

export function ConfidenceChip({ confidence }: { confidence: number }) {
  const tone =
    confidence >= 0.75
      ? cn("bg-app-green-1 text-app-green-4")
      : confidence >= 0.5
        ? cn("bg-app-amber-1 text-app-amber-4")
        : cn("bg-app-red-1 text-app-red-4");
  const pct = (confidence * 100).toFixed(0);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
        tone,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {pct}%
    </span>
  );
}
