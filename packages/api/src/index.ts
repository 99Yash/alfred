import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import {
  agent,
  approvalsRoutes,
  chatRoutes,
  connections,
  errorHandler,
  events,
  getSessionCached,
  invalidateSessionToken,
  onboardingRoutes,
  replicache,
  skillsRoutes,
  workflowRoutes,
} from "@alfred/http";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { meRoutes } from "./modules/me/index";
import { mcpIntegrationRoutes } from "./modules/mcp";
import { toolTiersRoutes } from "./modules/tools/index";

// `normalize: 'typebox'` opts out of Elysia 1.4's bundled `exact-mirror`
// schema cleaner in favour of TypeBox's native `Value.Clean`. Elysia
// 1.4.28 passes the wrong option key to `exact-mirror@1.0.0`
// (`TypeCompiler` vs the expected `Compile`), so every route with a
// `t.Optional(...)` query/body — which desugars to a Union internally —
// logs `[exact-mirror] TypeBox's TypeCompiler is required to use Union`
// on first hit. `Value.Clean` is slower but for a single-user app the
// per-request cost is negligible.
export const app = new Elysia({ name: "api", normalize: "typebox" })
  .use(errorHandler)
  .use(replicache)
  .use(events)
  .use(agent)
  .use(approvalsRoutes)
  .use(chatRoutes)
  .use(connections)
  .use(mcpIntegrationRoutes)
  .use(toolTiersRoutes)
  .use(meRoutes)
  .use(onboardingRoutes)
  .use(skillsRoutes)
  .use(workflowRoutes)
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

    let conn: BoundedRedis | undefined;
    try {
      conn = createRedisConnection("fail-fast", { tracked: false });
      await conn.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    } finally {
      // `tracked: false`, so `closeRedis()` never sees this one — close it here
      // so a failing probe cannot leak a perpetually-reconnecting socket.
      // quit() can reject if already broken; fall back to a hard disconnect.
      await conn?.quit().catch(() => conn?.disconnect());
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
