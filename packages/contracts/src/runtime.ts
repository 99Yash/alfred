export const COMPACTION_THRESHOLD_PCT = 0.6;

export function compactionThresholdTokens(modelContextWindow: number): number {
  return Math.floor(modelContextWindow * COMPACTION_THRESHOLD_PCT);
}

export const SCRATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

export function sharedKey(
  runId: string,
  path: string,
): `alfred:scratch:${string}:shared.${string}` {
  return `alfred:scratch:${runId}:shared.${path}`;
}

export function subAgentKey(
  runId: string,
  subId: string,
  path: string,
): `alfred:scratch:${string}:scratch.${string}.${string}` {
  return `alfred:scratch:${runId}:scratch.${subId}.${path}`;
}

export interface ScratchEntry<T = unknown> {
  value: T;
  zone: "shared" | "scratch";
  writtenBy: string;
  writtenAt: number;
}
