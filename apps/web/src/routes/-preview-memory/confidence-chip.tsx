import { cn } from "~/lib/utils";

export function ConfidenceChip({ confidence }: { confidence: number }) {
  const tone =
    confidence >= 0.75
      ? cn("bg-vs-green-1 text-vs-green-4")
      : confidence >= 0.5
        ? cn("bg-vs-amber-1 text-vs-amber-4")
        : cn("bg-vs-red-1 text-vs-red-4");
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
