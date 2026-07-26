import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Human duration for a chat-surface timing label: sub-10s keeps a decimal so a
 * fast step still reads as having taken time ("1.2s"), longer runs round to
 * whole seconds, and past a minute it splits ("2m 4s"). Shared by the
 * "Thought for Ns" reasoning label and the live sub-agent trail.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60)
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m ${s}s`;
}

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

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
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
