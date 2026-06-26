/**
 * Trajectory extraction + paired diff for agent-run replay (the regression
 * primitive for multi-step runs).
 *
 * "Did my change do what I wanted, not just for one step?" can't be answered
 * from an aggregate score — at the dataset sizes a single-user app actually
 * has, the aggregate is dominated by model variance. The defensible answer is
 * the *diff*: run a recorded input through the old and new build and look at
 * what the trajectory did differently — which step changed (intended) and
 * which others moved (collateral).
 *
 * This module is the pure half: turn a Langfuse trace into a normalized
 * trajectory, and diff two trajectories. No I/O, no LLM calls — so it's unit
 * testable and deterministic. The runnable half (`scripts/replay-diff.ts`)
 * fetches the traces and prints the diff.
 *
 * The trajectory is built from the executed tool spans (#214) — the ground
 * truth of what ran, with success/error status from the span level. Because
 * generation outputs now also carry the model's *decided* calls (see
 * `captureOutput`), `decidedNotExecuted` surfaces calls the model proposed that
 * never executed (staged / HIL-gated / rejected) — invisible to a span-only view.
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
}

export interface TraceLike {
  id?: string;
  observations?: TraceObservation[];
}

/** One executed tool call in a run, normalized for comparison. */
export interface TrajectoryStep {
  toolName: string;
  /** Canonicalized args (object key order is irrelevant to identity). */
  input: unknown;
  status: "ok" | "error";
  /** Bounded error summary when status==="error". */
  error?: string;
}

export interface Trajectory {
  traceId: string | undefined;
  steps: TrajectoryStep[];
  /**
   * Calls the model decided to make (from generation outputs) whose toolCallId
   * never appeared as an executed span — proposed-but-not-run. Empty for a
   * clean run; non-empty means a gate/rejection diverted a decision.
   */
  decidedNotExecuted: { toolName: string; input: unknown }[];
}

const TOOL_SPAN_PREFIX = "tool:";

/** Recursively sort object keys so two args that differ only in key order compare equal. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable identity key for a step: tool name + canonical args. */
export function stepKey(step: { toolName: string; input: unknown }): string {
  return `${step.toolName}(${JSON.stringify(canonicalize(step.input))})`;
}

function byStartTime(a: TraceObservation, b: TraceObservation): number {
  return (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

/** Tool calls the model decided on, mined from generation outputs. */
function decidedCalls(obs: TraceObservation[]): { toolName: string; toolCallId?: string; input: unknown }[] {
  const calls: { toolName: string; toolCallId?: string; input: unknown }[] = [];
  for (const o of obs) {
    if (o.type !== "GENERATION") continue;
    const out = o.output;
    if (!out || typeof out !== "object") continue;
    const tc = (out as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(tc)) continue;
    for (const c of tc) {
      if (c && typeof c === "object" && typeof (c as { toolName?: unknown }).toolName === "string") {
        const call = c as { toolName: string; toolCallId?: string; input?: unknown };
        calls.push({ toolName: call.toolName, toolCallId: call.toolCallId, input: call.input });
      }
    }
  }
  return calls;
}

export function extractTrajectory(trace: TraceLike): Trajectory {
  const obs = (trace.observations ?? []).slice().sort(byStartTime);

  const steps: TrajectoryStep[] = [];
  const executedCallIds = new Set<string>();
  for (const o of obs) {
    if (o.type !== "SPAN" || !o.name.startsWith(TOOL_SPAN_PREFIX)) continue;
    const toolName = o.name.slice(TOOL_SPAN_PREFIX.length);
    const isError = (o.level ?? "").toUpperCase() === "ERROR";
    steps.push({
      toolName,
      input: canonicalize(o.input),
      status: isError ? "error" : "ok",
      ...(isError && o.statusMessage ? { error: String(o.statusMessage).slice(0, 200) } : {}),
    });
  }

  // Match decided calls to executed spans by toolCallId where present; anything
  // decided but unmatched is proposed-but-not-executed.
  const decided = decidedCalls(obs);
  for (const d of decided) {
    if (d.toolCallId) executedCallIds.add(d.toolCallId);
  }
  // A span doesn't carry the toolCallId in this slice, so we match decided →
  // executed positionally by (toolName, canonical args). Build a multiset of
  // executed keys and subtract.
  const executedKeys = new Map<string, number>();
  for (const s of steps) {
    const k = stepKey(s);
    executedKeys.set(k, (executedKeys.get(k) ?? 0) + 1);
  }
  const decidedNotExecuted: { toolName: string; input: unknown }[] = [];
  for (const d of decided) {
    const k = stepKey({ toolName: d.toolName, input: d.input });
    const remaining = executedKeys.get(k) ?? 0;
    if (remaining > 0) {
      executedKeys.set(k, remaining - 1);
    } else {
      decidedNotExecuted.push({ toolName: d.toolName, input: canonicalize(d.input) });
    }
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
  /** True when the trajectories are identical (nothing moved). */
  identical: boolean;
}

/** Longest common subsequence of two key arrays → indices kept on each side. */
function lcsKept(a: string[], b: string[]): { aKept: Set<number>; bKept: Set<number> } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
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
 * Paired diff of two trajectories. LCS on (toolName + canonical args) gives the
 * unchanged spine; leftover baseline/candidate steps are then paired by tool
 * name (in order) into `changed` (same tool, different args) so an arg tweak
 * reads as one change rather than a remove + add. Truly unpaired leftovers are
 * `removed` / `added`.
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
