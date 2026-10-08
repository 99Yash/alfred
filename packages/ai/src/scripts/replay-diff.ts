/**
 * Diff two runs of one input, old build against new. Only the targeted step should change.
 *
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/replay-diff.ts <baselineTraceId> <candidateTraceId>
 *
 * Find trace ids in the Langfuse UI, or:
 *   curl -s "$LANGFUSE_HOST/api/public/v2/observations?fields=trace_context&limit=20" \
 *     -H "Authorization: Basic $(printf '%s:%s' "$PK" "$SK" | base64)"
 */
import { serverEnv } from "@alfred/env/server";
import {
  diffTrajectories,
  extractTrajectory,
  summarizeDiff,
  type TraceLike,
} from "../replay/trajectory";
import { decodeLangfuseIo, fetchObservationsByTraceId } from "./langfuse-observations";

const FETCH_TIMEOUT_MS = 15_000;

async function fetchTrace(host: string, auth: string, traceId: string): Promise<TraceLike> {
  const observations = await fetchObservationsByTraceId({
    host,
    auth,
    traceId,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  return {
    id: traceId,
    observations: observations.map((o) => ({
      type: o.type,
      name: o.name ?? "",
      startTime: o.startTime,
      input: decodeLangfuseIo(o.input),
      output: decodeLangfuseIo(o.output),
      ...(o.level != null ? { level: o.level } : {}),
      ...(o.statusMessage != null ? { statusMessage: o.statusMessage } : {}),
      metadata: decodeLangfuseIo(o.metadata),
    })),
  };
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
