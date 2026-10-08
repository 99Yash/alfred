export const COMPACTION_THRESHOLD_PCT = 0.6;

export function compactionThresholdTokens(modelContextWindow: number): number {
  return Math.floor(modelContextWindow * COMPACTION_THRESHOLD_PCT);
}

export const SCRATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long a staged approval waits for the user before it auto-expires. One window for all tools. */
export const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

// `:` and `.` are key delimiters. A part that holds one could forge a key in another zone.
function assertScratchKeyPart(name: string, value: string): void {
  if (value.length === 0 || value.includes(":") || value.includes(".")) {
    throw new Error(
      `[scratchpad] ${name} must be non-empty and contain no ':' or '.' (got: ${JSON.stringify(value)})`,
    );
  }
}

export function scratchKeyPrefix(runId: string): `alfred:scratch:${string}:` {
  return `alfred:scratch:${runId}:`;
}

export function sharedKey(
  runId: string,
  path: string,
): `alfred:scratch:${string}:shared.${string}` {
  assertScratchKeyPart("runId", runId);
  assertScratchKeyPart("path", path);

  return `${scratchKeyPrefix(runId)}shared.${path}`;
}

export function subAgentKey(
  runId: string,
  subId: string,
  path: string,
): `alfred:scratch:${string}:scratch.${string}.${string}` {
  assertScratchKeyPart("runId", runId);
  assertScratchKeyPart("subId", subId);
  assertScratchKeyPart("path", path);

  return `${scratchKeyPrefix(runId)}scratch.${subId}.${path}`;
}

/** Strip the run prefix: `shared.<path>` or `scratch.<subId>.<path>`. */
export function logicalScratchKey(runId: string, fullKey: string): string {
  return fullKey.slice(scratchKeyPrefix(runId).length);
}

/** Boss-owned `shared.*` and per-sub-agent `scratch.*`. */
export const SCRATCH_ZONES = ["shared", "scratch"] as const;

export type ScratchZone = (typeof SCRATCH_ZONES)[number];

export interface ScratchEntry<T = unknown> {
  value: T;
  zone: ScratchZone;
  writtenBy: string;
  writtenAt: number;
}
