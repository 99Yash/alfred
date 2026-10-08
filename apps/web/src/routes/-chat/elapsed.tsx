import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { formatDuration } from "./duration";

/** Shorter steps end before the eye lands. */
const MIN_VISIBLE_MS = 400;

/** Matches the tenths the sub-10s format shows. */
const TICK_MS = 100;

/**
 * A duration that counts up while running and freezes when done.
 * Ticks on its own interval: the stream's frame loop parks when text catches up.
 * Times are client clock readings, so it shows what the user watched.
 */
export function Elapsed({
  startedTs,
  endedTs,
  className,
}: {
  startedTs: number;
  endedTs: number | null;
  className?: string | undefined;
}) {
  const running = endedTs === null;
  const [now, setNow] = useState(() => Date.now());

  // Re-read the time during render on resume; an effect paints one stale frame, a visible jump back.
  const [prevRunning, setPrevRunning] = useState(running);

  if (prevRunning !== running) {
    setPrevRunning(running);

    if (running) setNow(Date.now());
  }

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);

    return () => clearInterval(id);
  }, [running]);

  const elapsed = Math.max(0, (endedTs ?? now) - startedTs);

  if (elapsed < MIN_VISIBLE_MS) return null;

  return (
    <span className={cn("shrink-0 text-[11px] text-app-fg-2 tabular-nums", className)}>
      {formatDuration(elapsed)}
    </span>
  );
}
