// Keep first: Sentry must init before http/pg/ioredis load, or it cannot patch them.
// The bundled prod build also preloads it with `node --import`, since bundles lose import order.
import "./instrument";
import { Server as NodeHttpServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { flushLangfuse } from "@alfred/ai";
import { getPath } from "@alfred/contracts";
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

// This file owns the shutdown of the HTTP server. `app.stop()` cannot do it: the Node
// adapter never sets `app.server`, so the call always throws "Elysia isn't running"
// (elysiajs/node#67). The adapter's own `stop()` drops `closeActiveConnections`, so a close
// through it waits forever on the open SSE streams. Hold the Node server instead.
let httpServer: NodeHttpServer | undefined;

/** Bound on the listener close, so one stuck socket cannot block the rest of the shutdown. */
const HTTP_CLOSE_TIMEOUT_MS = 2000;

/** The Node HTTP server inside the adapter's listen handle, or `undefined` if its shape moved. */
function nodeHttpServer(handle: unknown): NodeHttpServer | undefined {
  const server = getPath(handle, "node", "server");

  return server instanceof NodeHttpServer ? server : undefined;
}

new Elysia({ adapter: node(), normalize: "typebox" })
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
      // srvx adds its own SIGINT/SIGTERM handler by default. It closes the listener before
      // `shutdown` runs and waits on open streams. Keep one owner of the shutdown order.
      gracefulShutdown: false,
    },
    (handle) => {
      httpServer = nodeHttpServer(handle);

      if (!httpServer) {
        logger.warn("Listen handle has no Node HTTP server; shutdown cannot close it");
      }

      logger.info(`Alfred server running on port ${serverEnv().PORT}`);
    },
  );

let shuttingDown = false;

async function shutdown(signal: string) {
  // A second signal would double-close the pools.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down...`);

  await closeHttpServer();
  await stopRuntime();
  // oxlint-disable-next-line alfred/no-swallowed-catch -- shutdown goes on; a failed flush has no reporter left to tell it to
  await Sentry.flush(2000).catch(() => {});
  process.exit(0);
}

/**
 * Stop new connections, then end the open ones. SSE streams never end on their own, so a
 * plain `close()` would wait on them forever.
 */
async function closeHttpServer(): Promise<void> {
  const server = httpServer;

  // `undefined` already logged a warning at boot.
  if (!server) return;

  if (!server.listening) {
    logger.warn("HTTP server was already closed before shutdown");

    return;
  }

  const closed = new Promise<"closed">((resolve) => {
    server.close((err) => {
      if (err) logger.error({ err }, "Error closing HTTP server");
      resolve("closed");
    });
  });

  server.closeAllConnections();

  const outcome = await Promise.race([
    closed,
    sleep(HTTP_CLOSE_TIMEOUT_MS, "timed-out" as const, { ref: false }),
  ]);

  if (outcome === "timed-out") {
    logger.warn("HTTP server did not close in time; shutting down anyway");
  } else {
    logger.info("HTTP server closed");
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
