/**
 * Human duration for a chat-surface timing label: sub-10s keeps a decimal so a
 * fast step still reads as having taken time ("1.2s"), longer runs round to
 * whole seconds, and past a minute it splits ("2m 4s"). Shared by the
 * "Thought for Ns" reasoning label and the live `Elapsed` clock, so a frozen
 * duration and a running one are spelled the same way.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60)
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m ${s}s`;
}
