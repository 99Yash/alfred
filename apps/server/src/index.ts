// MUST be the first import: Sentry.init() has to run before the instrumented
// libraries (http/pg/ioredis/undici, all pulled in transitively by
// @alfred/api) are evaluated, or the HTTP/fetch auto-instrumentation never
// patches them. In dev (tsx, unbundled) ESM source order guarantees this. In
// the bundled prod build, the `start` script ALSO preloads it via
// `node --import ./dist/instrument.js` — bundlers don't preserve import order
// across inlined modules, so the preload is the authoritative fix there; this
// import is then a harmless cache hit on the same module instance.
import "./instrument";
import { flushLangfuse } from "@alfred/ai";
import { app, securityHeaders } from "@alfred/api";
import { toMessage } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { cors } from "@elysiajs/cors";
import { node } from "@elysiajs/node";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import { startRuntime, stopRuntime } from "./runtime";

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
    // Flush Sentry AND Langfuse before exit — both batch events in memory, so a
    // crash otherwise drops the trace/spans for the turn that died. Bound the
    // wait: a stuck network flush must never wedge the crash handler. Metering
    // writes are skipped here (the DB pool may be unhealthy mid-crash and a
    // fast, clean exit matters more than the cost rows).
    await Promise.race([
      Promise.allSettled([Sentry.flush(2000), flushLangfuse()]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
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
  // Browser security headers on every API response (#295). HSTS only in prod,
  // where the Railway edge serves HTTPS — never on the local http origin.
  .use(securityHeaders({ hsts: serverEnv().NODE_ENV === "production" }))
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
