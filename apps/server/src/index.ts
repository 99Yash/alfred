import {
  app,
  closeAgentQueue,
  closeBriefingQueue,
  closeConnections,
  closeEventBridge,
  closeIngestionQueue,
  closeMemoryQueue,
  closeRedis,
  closeReplicachePokeBridge,
  closeWorkflowsQueue,
  initEventBridge,
  initReplicachePokeBridge,
  scheduleRepeatableBriefingJobs,
  scheduleRepeatableIngestionJobs,
  scheduleRepeatableMemoryJobs,
  scheduleRepeatableWorkflowsJobs,
  registerOnUserCreated,
  seedBuiltinWorkflowsForUser,
  startAgentWorker,
  startBriefingWorker,
  startIngestionWorker,
  startMemoryWorker,
  startWorkflowsWorker,
  stopAgentWorker,
  stopBriefingWorker,
  stopIngestionWorker,
  stopMemoryWorker,
  stopWorkflowsWorker,
  warmPool,
} from "@alfred/api";
import { serverEnv } from "@alfred/env/server";
import { cors } from "@elysiajs/cors";
import { node } from "@elysiajs/node";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import { registerBuiltinWorkflows } from "./builtins";
import "./instrument";

// Boot sequence: connect to Postgres pool, realtime event bridge, Replicache poke bus.
await warmPool();
await initEventBridge();
await initReplicachePokeBridge();
// Register built-in workflows BEFORE the worker starts pulling jobs —
// otherwise a job picked up first might not find its workflow slug.
registerBuiltinWorkflows();
// Register the post-signup hook BEFORE Better Auth's databaseHooks can
// fire. New users get their builtin `workflows` rows seeded immediately
// so the settings page + workflows.tick partial index see them from
// turn 0.
registerOnUserCreated(async (user) => {
  await seedBuiltinWorkflowsForUser(user.id);
});
await startAgentWorker();
await startIngestionWorker();
await startMemoryWorker();
await startBriefingWorker();
await startWorkflowsWorker();
// Register the m7c repeatable jobs (poll-sweep, watch-renew, embed-sweep).
// Idempotent: rerunning on every boot upserts the same scheduler ids.
await scheduleRepeatableIngestionJobs();
// Daily memory-extraction trigger (m8b). Idempotent like the ingestion ones.
await scheduleRepeatableMemoryJobs();
// Hourly briefing.tick (m10c). Same idempotency story.
await scheduleRepeatableBriefingJobs();
// Per-minute generic workflows.tick (ADR-0027). Reads the partial
// `workflows_next_run_at_idx`; user-authored cron workflows fire here.
// Per-feature ticks (briefing/memory) still own their lanes; their
// builtin rows seed with `next_run_at = null` to stay out of this scan.
await scheduleRepeatableWorkflowsJobs();

const server = new Elysia({ adapter: node() })
  .use(
    cors({
      origin: serverEnv().CORS_ORIGIN,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
  .use(app)
  .listen({ port: Number(process.env.PORT) || 3001, hostname: "0.0.0.0" }, () => {
    const port = Number(process.env.PORT) || 3001;
    console.log(`Alfred server running on http://0.0.0.0:${port}`);
  });

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  await server.stop();
  try {
    // Stop the agent worker FIRST so in-flight steps finish and commit
    // (or roll back) before we yank Redis. Per ADR-0014: graceful
    // shutdown drains the active step.
    await stopAgentWorker();
    await closeAgentQueue();
    await stopIngestionWorker();
    await closeIngestionQueue();
    await stopMemoryWorker();
    await closeMemoryQueue();
    await stopBriefingWorker();
    await closeBriefingQueue();
    await stopWorkflowsWorker();
    await closeWorkflowsQueue();
    console.log("Workers stopped");
  } catch (err) {
    console.error("Error stopping workers:", err instanceof Error ? err.message : String(err));
  }
  try {
    await closeEventBridge();
    await closeReplicachePokeBridge();
    await closeRedis();
    console.log("Redis closed");
  } catch (err) {
    console.error("Error closing Redis:", err instanceof Error ? err.message : String(err));
  }
  try {
    await closeConnections();
    console.log("DB pool closed");
  } catch (err) {
    console.error("Error closing DB:", err instanceof Error ? err.message : String(err));
  }
  await Sentry.flush(2000).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
