/**
 * Print where one agent run's time went (model, tools, approval wait, sub-agent
 * wait, queue) from Postgres alone, via `getRunBottleneckSummary` (#409).
 *
 * Run locally (needs serverEnv DB vars) from apps/server:
 *   ./node_modules/.bin/tsx --env-file=.env src/scripts/probes/probe-run-bottlenecks.ts <runId>
 */
import {
  getRunBottleneckSummary,
  type RunBottleneckSummary,
} from "@alfred/assistant/execution/run-bottlenecks";

const ms = (n: number | null): string => (n == null ? "   n/a" : `${Math.round(n)}ms`);

/** A bucket's share of wall-clock time, when that is known. */
function pct(part: number, whole: number | null): string {
  if (!whole || whole <= 0) return "";

  return ` (${((part / whole) * 100).toFixed(1)}%)`;
}

function print(runId: string, s: RunBottleneckSummary): void {
  const wall = s.wallClockMs;

  const lines = [
    `# Run bottleneck summary — ${runId}`,
    ``,
    `wall_clock     ${ms(wall)}`,
    `  model        ${ms(s.modelMs)}${pct(s.modelMs, wall)}  in=${s.inputTokens} out=${s.outputTokens} cost=$${s.costUsd.toFixed(4)}`,
    `  tool         ${ms(s.toolMs)}${pct(s.toolMs, wall)}  (dispatch-batch wall time)`,
    `  approval_wait ${ms(s.approvalWaitMs)}${pct(s.approvalWaitMs, wall)}`,
    `  sub_agent_wait ${ms(s.subAgentWaitMs)}${pct(s.subAgentWaitMs, wall)}`,
    `  queue        ${ms(s.queueMs)}${pct(s.queueMs, wall)}  (time-in-queue + reclaim delay)`,
    ``,
    `reclaims=${s.reclaims}  stagings_rejected=${s.stagingsRejected}  stagings_expired=${s.stagingsExpired}`,
    ``,
    `# Note: per-tool and scratchpad timings live only in Langfuse spans (#406/#408);`,
    `# 'tool' here is the dispatch-tools step wall time and scratch time is omitted.`,
  ];

  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const runId = process.argv[2];

  if (!runId) throw new Error("usage: probe-run-bottlenecks <runId>");
  const summary = await getRunBottleneckSummary(runId);

  if (!summary) {
    console.log(`# no agent_runs row for ${runId}`);

    return;
  }

  print(runId, summary);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
