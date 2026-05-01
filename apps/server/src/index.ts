import {
  app,
  closeAgentQueue,
  closeConnections,
  closeEventBridge,
  closeIngestionQueue,
  closeRedis,
  closeReplicachePokeBridge,
  initEventBridge,
  initReplicachePokeBridge,
  startAgentWorker,
  startIngestionWorker,
  stopAgentWorker,
  stopIngestionWorker,
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
await startAgentWorker();
await startIngestionWorker();

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
    console.log("Workers stopped");
  } catch (err) {
    console.error(
      "Error stopping workers:",
      err instanceof Error ? err.message : String(err),
    );
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
