import {
  app,
  closeConnections,
  closeEventBridge,
  closeRedis,
  closeReplicachePokeBridge,
  initEventBridge,
  initReplicachePokeBridge,
  warmPool,
} from "@alfred/api";
import { serverEnv } from "@alfred/env/server";
import { cors } from "@elysiajs/cors";
import { node } from "@elysiajs/node";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import "./instrument";

// Boot sequence: connect to Postgres pool, realtime event bridge, Replicache poke bus.
await warmPool();
await initEventBridge();
await initReplicachePokeBridge();

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
