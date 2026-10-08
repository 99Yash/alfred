/** "1.2s" under 10s, whole seconds after, "2m 4s" past a minute. For reasoning labels and `Elapsed`. */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;

  if (totalSeconds < 60)
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);

  return `${m}m ${s}s`;
}
