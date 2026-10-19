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

  // On resume, `now` is the last tick before the stop and reads earlier than the frozen end.
  // Raise it to that end during render so the count never jumps back; the next tick moves it on.
  const [prevEndedTs, setPrevEndedTs] = useState(endedTs);

  if (prevEndedTs !== endedTs) {
    setPrevEndedTs(endedTs);

    if (running && prevEndedTs !== null) setNow((n) => Math.max(n, prevEndedTs));
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
