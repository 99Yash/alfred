/**
 * Paired trajectory diff for two recorded agent runs (the regression check for
 * multi-step runs — see replay/trajectory.ts for the why).
 *
 * Workflow: run a recorded input through the OLD build → note its run id; run
 * the same input through the NEW build → note its run id; diff the two. What
 * changed is the answer to "did my change do what I wanted, not just for one
 * step" — the targeted step should differ, nothing else should.
 *
 * Run from packages/ai (needs LANGFUSE_* in env):
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/replay-diff.ts <baselineTraceId> <candidateTraceId>
 *
 * Tip: list recent boss runs to grab ids:
 *   curl -s "$LANGFUSE_HOST/api/public/traces?limit=20&tags=role:boss" \
 *     -H "Authorization: Basic $(printf '%s:%s' "$PK" "$SK" | base64)"
 */
import { serverEnv } from "@alfred/env/server";
import {
  diffTrajectories,
  extractTrajectory,
  summarizeDiff,
  type TraceLike,
} from "../replay/trajectory";

const FETCH_TIMEOUT_MS = 15_000;

async function fetchTrace(host: string, auth: string, traceId: string): Promise<TraceLike> {
  const res = await fetch(`${host}/api/public/traces/${traceId}`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET trace ${traceId} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<TraceLike>;
}

async function main() {
  const [baselineId, candidateId] = process.argv.slice(2);
  if (!baselineId || !candidateId) {
    console.error(
      "usage: replay-diff.ts <baselineTraceId> <candidateTraceId>\n" +
        "  (run the same input through old and new build, pass each run id)",
    );
    process.exit(2);
  }

  const env = serverEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    throw new Error("LANGFUSE keys missing — point --env-file at a configured .env");
  }
  const host = env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    "base64",
  );

  const [baseTrace, candTrace] = await Promise.all([
    fetchTrace(host, auth, baselineId),
    fetchTrace(host, auth, candidateId),
  ]);
  const baseline = extractTrajectory(baseTrace);
  const candidate = extractTrajectory(candTrace);

  console.log(`baseline  ${baselineId}: ${baseline.steps.length} tool step(s)`);
  console.log(`candidate ${candidateId}: ${candidate.steps.length} tool step(s)`);
  for (const tj of [baseline, candidate]) {
    if (tj.decidedNotExecuted.length > 0) {
      console.log(
        `  note: ${tj.traceId} had ${tj.decidedNotExecuted.length} decided-but-not-executed call(s): ` +
          tj.decidedNotExecuted.map((d) => d.toolName).join(", "),
      );
    }
  }
  console.log("");
  const diff = diffTrajectories(baseline, candidate);
  console.log(summarizeDiff(diff));
  process.exit(diff.identical ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
