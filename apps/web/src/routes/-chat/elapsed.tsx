import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { formatDuration } from "./duration";

/** Below this, a live counter is noise — the step ends before the eye lands. */
const MIN_VISIBLE_MS = 400;

/** Live tick interval. 100ms matches the tenths the sub-10s format shows. */
const TICK_MS = 100;

/**
 * A duration that counts up while the work runs and freezes when it lands.
 *
 * Self-ticking on its own interval rather than riding the stream snapshot: the
 * chat stream's animation frame loop parks once the text buffers catch up, so a
 * clock driven from there would stall mid-step, and forcing the loop to keep
 * spinning for a label would re-render the whole turn 10× a second.
 *
 * `startedTs` / `endedTs` are client clock readings taken when the tool events
 * arrived, so this measures what the user actually watched elapse.
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

  // The frozen clock goes stale while a step is landed. If one ever resumes,
  // re-read the time during render rather than in the effect — an effect would
  // paint one frame of the stale duration first, which for a clock is visibly
  // a jump backwards.
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
