// MUST be the first import: Sentry.init() has to run before the instrumented
// libraries (http/pg/ioredis/undici, all pulled in transitively by
// @alfred/api) are evaluated, or the HTTP/fetch auto-instrumentation never
// patches them. In dev (tsx, unbundled) ESM source order guarantees this. In
// the bundled prod build, the `start` script ALSO preloads it via
// `node --import ./dist/instrument.js` — bundlers don't preserve import order
// across inlined modules, so the preload is the authoritative fix there; this
// import is then a harmless cache hit on the same module instance.
import "./instrument";
import {
  app,
  closeAgentQueue,
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
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
  ensureDefaultActionPolicyForUser,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
  scheduleRepeatableBriefingJobs,
  scheduleRepeatableIngestionJobs,
  scheduleRepeatableMemoryJobs,
  scheduleRepeatableWorkflowsJobs,
  registerBuiltinTools,
  registerOnUserCreated,
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
  startAgentWorker,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  startBriefingWorker,
  startIngestionWorker,
  startMemoryWorker,
  startWorkflowsWorker,
  stopAgentWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
  stopBriefingWorker,
  stopIngestionWorker,
  stopMemoryWorker,
  stopWorkflowsWorker,
  verifyMeteringModels,
  warmPool,
} from "@alfred/api";
import { serverEnv } from "@alfred/env/server";
import { cors } from "@elysiajs/cors";
import { node } from "@elysiajs/node";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import { registerBuiltinWorkflows } from "./builtins";
import { toMessage } from "@alfred/contracts";

// Global crash safety net, registered before any worker starts. An unhandled
// rejection or uncaught exception in a background BullMQ processor or the event
// bridge must NOT leave a half-dead process that keeps leasing jobs it can no
// longer complete. Capture it (a no-op when Sentry is unconfigured) and exit(1)
// so the orchestrator restarts a clean worker. This is DSN-independent: without
// a DSN there are no Sentry handlers at all, and Sentry's own unhandledRejection
// integration defaults to 'warn' (logs without exiting) even when configured.
let crashing = false;
async function handleFatal(kind: string, err: unknown): Promise<void> {
  if (crashing) return;
  crashing = true;
  console.error(`Fatal ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  try {
    Sentry.captureException(err);
    await Sentry.flush(2000);
  } catch {
    // Never let the crash handler itself throw.
  }
  process.exit(1);
}
process.on("unhandledRejection", (reason) => void handleFatal("unhandledRejection", reason));
process.on("uncaughtException", (err) => void handleFatal("uncaughtException", err));

// Boot sequence: connect to Postgres pool, realtime event bridge, Replicache poke bus.
await warmPool();
// ADR-0035 guard: every agent model must have a populated
// `model_prices.context_window`. A missing value means the compactor
// can't size its 60% threshold, so the boss would loop unbounded. Fail
// loud at boot with a clear remediation rather than wedge at runtime.
await verifyMeteringModels();
await initEventBridge();
await initReplicachePokeBridge();
// Register built-in workflows BEFORE the worker starts pulling jobs —
// otherwise a job picked up first might not find its workflow slug.
registerBuiltinWorkflows();
// Register the m13 boss/sub-agent tool slice into the in-process
// registry. Must happen before the agent worker pulls jobs so any
// dispatched tool call can resolve `getTool(name)` on the first turn.
registerBuiltinTools();
// Register the post-signup hook BEFORE Better Auth's databaseHooks can
// fire. New users get their builtin `workflows` rows seeded immediately
// so the settings page + workflows.tick partial index see them from
// turn 0.
registerOnUserCreated(async (user) => {
  await seedBuiltinWorkflowsForUser(user.id);
  await ensureDefaultActionPolicyForUser(user.id);
});
// Re-seed builtin workflow rows for EVERY existing user on boot. The
// on-user-created hook above only covers new signups, so a builtin whose
// definition changed in code (trigger/name/description) never reached
// pre-existing users on deploy — which silently severed prod email triage
// when the trigger shape changed out from under a frozen `workflows` row.
// Idempotent and leaves user-owned status/next_run_at untouched.
await seedBuiltinWorkflowsForAllUsers();
// Subscribe to `policy-bust:u:*` so policy edits on one server instance
// drop every other instance's cached row before the next dispatch. Must
// start before the agent worker so the cache is invalidation-aware on
// the very first turn.
await startPolicyBustSubscriber();
await startAgentWorker();
await startIngestionWorker();
await startMemoryWorker();
await startBriefingWorker();
await startWorkflowsWorker();
await startApprovalNotificationWorker();
await startApprovalExpiryWorker();
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

const server = new Elysia({ adapter: node(), normalize: "typebox" })
  .use(
    cors({
      origin: serverEnv().CORS_ORIGIN,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
  .use(app)
  .listen({ port: serverEnv().PORT, hostname: "0.0.0.0" }, () => {
    console.log(`Alfred server running on http://0.0.0.0:${serverEnv().PORT}`);
  });

let shuttingDown = false;

async function shutdown(signal: string) {
  // Signals can fire more than once (e.g. SIGTERM then SIGINT); a second
  // pass would double-close pools and re-throw. Run the teardown once.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  try {
    await server.stop();
  } catch (err) {
    // server.stop() throws "Elysia isn't running" if a signal arrives before
    // listen() resolves or after the adapter has already stopped. That must
    // not abort the rest of teardown below.
    console.error("Error stopping server:", toMessage(err));
  }
  try {
    // Stop the agent worker FIRST so in-flight steps finish and commit
    // (or roll back) before we yank Redis. Per ADR-0014: graceful
    // shutdown drains the active step.
    await stopAgentWorker();
    await closeAgentQueue();
    await stopApprovalNotificationWorker();
    await closeApprovalNotificationQueue();
    await stopApprovalExpiryWorker();
    await closeApprovalExpiryQueue();
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
    console.error("Error stopping workers:", toMessage(err));
  }
  try {
    await stopPolicyBustSubscriber();
    await closeEventBridge();
    await closeReplicachePokeBridge();
    await closeRedis();
    console.log("Redis closed");
  } catch (err) {
    console.error("Error closing Redis:", toMessage(err));
  }
  try {
    await closeConnections();
    console.log("DB pool closed");
  } catch (err) {
    console.error("Error closing DB:", toMessage(err));
  }
  await Sentry.flush(2000).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
