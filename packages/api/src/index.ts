import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { errorHandler } from "./middleware/error-handler.js";
import { getSessionCached, invalidateSessionToken } from "./middleware/session-cache.js";
import { createUntrackedRedisConnection } from "./queue/connection.js";
import { events } from "./modules/events/index.js";
import { replicache } from "./modules/replicache/index.js";

export { closeConnections, warmPool } from "@alfred/db";
export { closeRedis } from "./queue/connection.js";
export { initEventBridge, closeEventBridge } from "./events/index.js";
export { initReplicachePokeBridge, closeReplicachePokeBridge } from "./events/replicache-events.js";
export { publishEvent } from "./events/publish.js";
export type { EventFrame, EventKind, EventPayload } from "./events/types.js";

export const app = new Elysia({ name: "api" })
  .use(errorHandler)
  .use(replicache)
  .use(events)
  .get("/health", async ({ set }) => {
    try {
      await db().execute(sql`SELECT 1`);
      return { ok: true, db: "connected" };
    } catch {
      set.status = 503;
      return { ok: false, db: "disconnected" };
    }
  })
  .get("/ready", async ({ set }) => {
    const checks: Record<string, "ok" | "error"> = {};

    try {
      await db().execute(sql`SELECT 1`);
      checks.db = "ok";
    } catch {
      checks.db = "error";
    }

    try {
      const conn = createUntrackedRedisConnection();
      await conn.ping();
      await conn.quit();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }

    const allOk = Object.values(checks).every((v) => v === "ok");
    if (!allOk) set.status = 503;
    return { ok: allOk, checks };
  })
  .get("/api/auth/get-session", async ({ request, set }) => {
    try {
      const session = await getSessionCached(request);
      set.headers["Cache-Control"] = "private, no-store";
      return session;
    } catch {
      set.headers["Cache-Control"] = "private, no-store";
      return null;
    }
  })
  .onRequest(({ request }) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/auth/sign-out") {
      invalidateSessionToken(request.headers);
    }
  })
  .mount(auth().handler);

export type App = typeof app;
