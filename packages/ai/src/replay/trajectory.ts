import { getStringPath, isRecord } from "@alfred/contracts";

/**
 * Turn a Langfuse trace into a tool-call trajectory, and diff two of them.
 * Pure; the runnable half is `packages/ai/src/scripts/replay-diff.ts`.
 * At single-user scale an aggregate eval score is mostly model noise, so compare paired runs.
 */

/** The slice of a Langfuse observation this module reads. */
export interface TraceObservation {
  type: string; // "SPAN" | "GENERATION" | ...
  name: string;
  startTime?: string | null;
  input?: unknown;
  output?: unknown;
  level?: string | null; // "DEFAULT" | "ERROR" | ...
  statusMessage?: string | null;
  /** Untrusted. Tool spans carry `toolCallId`. */
  metadata?: unknown;
}

export interface TraceLike {
  id?: string;
  observations?: TraceObservation[];
}

/** One executed tool call in a run, normalized for comparison. */
interface TrajectoryStep {
  toolName: string;
  /** Keys sorted. */
  input: unknown;
  status: "ok" | "error";

  error?: string;
}

export interface Trajectory {
  traceId: string | undefined;
  steps: TrajectoryStep[];
  /** Calls the model proposed that never ran (staged, gated, or rejected). */
  decidedNotExecuted: { toolName: string; input: unknown }[];
}

const TOOL_SPAN_PREFIX = "tool:";

/** Sort object keys recursively, so key order does not affect equality. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        const v = value[key];

        // An absent key and an explicit `undefined` must compare equal.
        if (v === undefined) return out;
        out[key] = canonicalize(v);

        return out;
      }, {});
  }

  return value;
}

export function stepKey(step: { toolName: string; input: unknown }): string {
  return `${step.toolName}(${JSON.stringify(canonicalize(step.input))})`;
}

function byStartTime(a: TraceObservation, b: TraceObservation): number {
  return (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

/** Tool calls the model decided on, mined from generation outputs. */
function decidedCalls(
  obs: TraceObservation[],
): { toolName: string; toolCallId?: string; input: unknown }[] {
  const calls: { toolName: string; toolCallId?: string; input: unknown }[] = [];

  for (const o of obs) {
    if (o.type !== "GENERATION") continue;
    const out = o.output;

    if (!isRecord(out)) continue;
    const tc = out.toolCalls;

    if (!Array.isArray(tc)) continue;

    for (const c of tc) {
      if (!isRecord(c)) continue;
      const toolName = getStringPath(c, "toolName");

      if (toolName === undefined) continue;
      const toolCallId = getStringPath(c, "toolCallId");
      calls.push({
        toolName,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        input: c.input,
      });
    }
  }

  return calls;
}

function readToolCallId(metadata: unknown): string | undefined {
  return getStringPath(metadata, "toolCallId");
}

export function extractTrajectory(trace: TraceLike): Trajectory {
  const obs = (trace.observations ?? []).slice().sort(byStartTime);

  const steps: TrajectoryStep[] = [];
  const executedCallIds = new Set<string>();
  const executedKeys = new Map<string, number>();
  const executedKeyByCallId = new Map<string, string>();

  for (const o of obs) {
    if (o.type !== "SPAN" || !o.name.startsWith(TOOL_SPAN_PREFIX)) continue;
    const toolName = o.name.slice(TOOL_SPAN_PREFIX.length);
    const isError = (o.level ?? "").toUpperCase() === "ERROR";

    const step: TrajectoryStep = {
      toolName,
      input: canonicalize(o.input),
      status: isError ? "error" : "ok",
      ...(isError && o.statusMessage ? { error: String(o.statusMessage).slice(0, 200) } : {}),
    };

    steps.push(step);
    const callId = readToolCallId(o.metadata);
    const k = stepKey(step);

    if (callId) {
      executedCallIds.add(callId);
      executedKeyByCallId.set(callId, k);
    }

    executedKeys.set(k, (executedKeys.get(k) ?? 0) + 1);
  }

  // Match by toolCallId: args change between decision and execution (defaults, resolved dates).
  // Match by name and args only when a call has no id.
  const decided = decidedCalls(obs);
  const decidedNotExecuted: { toolName: string; input: unknown }[] = [];

  for (const d of decided) {
    if (d.toolCallId) {
      if (!executedCallIds.has(d.toolCallId)) {
        decidedNotExecuted.push({ toolName: d.toolName, input: canonicalize(d.input) });
      } else {
        // Consume the span, so a later call with no id cannot match it again.
        const k = executedKeyByCallId.get(d.toolCallId);

        if (k !== undefined) {
          const remaining = executedKeys.get(k) ?? 0;

          if (remaining > 0) executedKeys.set(k, remaining - 1);
        }
      }

      continue;
    }

    const k = stepKey({ toolName: d.toolName, input: d.input });
    const remaining = executedKeys.get(k) ?? 0;

    if (remaining > 0) executedKeys.set(k, remaining - 1);
    else decidedNotExecuted.push({ toolName: d.toolName, input: canonicalize(d.input) });
  }

  return { traceId: trace.id, steps, decidedNotExecuted };
}

// ── Paired diff ──────────────────────────────────────────────────────────────

export interface TrajectoryDiff {
  unchanged: TrajectoryStep[];
  /** Same tool at an aligned position, different args. */
  changed: { toolName: string; before: TrajectoryStep; after: TrajectoryStep }[];
  /** In candidate, not baseline. */
  added: TrajectoryStep[];
  /** In baseline, not candidate. */
  removed: TrajectoryStep[];
  identical: boolean;
}

/** Longest common subsequence of two key arrays → indices kept on each side. */
function lcsKept(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const aKept = new Set<number>();
  const bKept = new Set<number>();
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aKept.add(i);
      bKept.add(j);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  return { aKept, bKept };
}

/**
 * LCS finds the unchanged steps. Leftovers with the same tool name pair up as `changed`,
 * so an argument change reads as one change, not a remove and an add.
 */
export function diffTrajectories(baseline: Trajectory, candidate: Trajectory): TrajectoryDiff {
  const aKeys = baseline.steps.map(stepKey);
  const bKeys = candidate.steps.map(stepKey);
  const { aKept, bKept } = lcsKept(aKeys, bKeys);

  const unchanged: TrajectoryStep[] = [];

  for (let i = 0; i < baseline.steps.length; i++) {
    if (aKept.has(i)) unchanged.push(baseline.steps[i]!);
  }

  const removedLeft = baseline.steps.filter((_, i) => !aKept.has(i));
  const addedLeft = candidate.steps.filter((_, i) => !bKept.has(i));

  // Pair leftovers by tool name (greedy, in order) → args changed.
  const changed: TrajectoryDiff["changed"] = [];
  const removed: TrajectoryStep[] = [];
  const addedRemaining = addedLeft.slice();

  for (const before of removedLeft) {
    const idx = addedRemaining.findIndex((s) => s.toolName === before.toolName);

    if (idx >= 0) {
      changed.push({ toolName: before.toolName, before, after: addedRemaining[idx]! });
      addedRemaining.splice(idx, 1);
    } else {
      removed.push(before);
    }
  }

  return {
    unchanged,
    changed,
    added: addedRemaining,
    removed,
    identical: changed.length === 0 && addedRemaining.length === 0 && removed.length === 0,
  };
}

/** Human-readable one-screen summary of a diff. */
export function summarizeDiff(diff: TrajectoryDiff): string {
  if (diff.identical) {
    return `✅ identical trajectory — ${diff.unchanged.length} step(s), nothing moved.`;
  }

  const lines: string[] = [
    `⚠️  trajectory changed — ${diff.unchanged.length} unchanged, ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed.`,
  ];

  for (const c of diff.changed) {
    lines.push(`  ~ ${c.toolName} args changed:`);
    lines.push(`      before: ${JSON.stringify(c.before.input)}`);
    lines.push(`      after:  ${JSON.stringify(c.after.input)}`);
  }

  for (const s of diff.added) lines.push(`  + ${s.toolName} ${JSON.stringify(s.input)}`);

  for (const s of diff.removed) lines.push(`  - ${s.toolName} ${JSON.stringify(s.input)}`);

  return lines.join("\n");
}
