// Keep first: Sentry must init before http/pg/ioredis load, or it cannot patch them.
// The bundled prod build also preloads it with `node --import`, since bundles lose import order.
import "./instrument";
import { flushLangfuse } from "@alfred/ai";
import { serverEnv } from "@alfred/env/server";
import { app, securityHeaders } from "@alfred/http";
import { logger } from "@alfred/logging";
import { cors } from "@elysiajs/cors";
import { node } from "@elysiajs/node";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import { OBSERVABILITY_FLUSH_TIMEOUT_MS, startRuntime, stopRuntime } from "./runtime";

// Exit on any unhandled error, so a half-dead process does not keep leasing jobs.
// Sentry's own handler only warns, and without a DSN there is none.
let crashing = false;

async function handleFatal(kind: string, err: unknown): Promise<void> {
  if (crashing) return;
  crashing = true;
  // Production logs drop the error message; Sentry below keeps the whole error.
  logger.fatal({ err }, `Fatal ${kind}`);

  try {
    Sentry.captureException(err);
    // Both batch in memory, so flush to keep the crashed turn's spans.
    // Skip metering writes: the DB pool may be unhealthy mid-crash.
    await Promise.race([
      Promise.allSettled([Sentry.flush(2000), flushLangfuse()]),
      new Promise((resolve) => {
        setTimeout(resolve, OBSERVABILITY_FLUSH_TIMEOUT_MS).unref();
      }),
    ]);
  } catch {
    // Never let the crash handler itself throw.
  }

  process.exit(1);
}

process.on("unhandledRejection", (reason) => void handleFatal("unhandledRejection", reason));

process.on("uncaughtException", (err) => void handleFatal("uncaughtException", err));

await startRuntime();

const server = new Elysia({ adapter: node(), normalize: "typebox" })
  .use(
    cors({
      origin: serverEnv().CORS_ORIGIN,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
  // HSTS only in prod, where the Railway edge serves HTTPS.
  .use(securityHeaders({ hsts: serverEnv().NODE_ENV === "production" }))
  .use(app)
  // Dev binds `::` because Chrome resolves `localhost` to `::1` and an IPv4-only bind hangs.
  // The Railway edge is IPv4.
  .listen(
    {
      port: serverEnv().PORT,
      hostname: serverEnv().NODE_ENV === "production" ? "0.0.0.0" : "::",
    },
    () => {
      logger.info(`Alfred server running on port ${serverEnv().PORT}`);
    },
  );

let shuttingDown = false;

async function shutdown(signal: string) {
  // A second signal would double-close the pools.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down...`);

  try {
    await server.stop();
  } catch (err) {
    // Throws "Elysia isn't running" if the signal beats listen(). Keep tearing down.
    logger.error({ err }, "Error stopping server");
  }

  await stopRuntime();
  await Sentry.flush(2000).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
