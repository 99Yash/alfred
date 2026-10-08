import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { agent } from "./agent";
import { approvalsRoutes } from "./approvals";
import { chatRoutes } from "./chat";
import { connections } from "./connections";
import { integrationsRoutes } from "./integrations";
import { mcpIntegrationRoutes } from "./mcp";
import { meRoutes } from "./me";
import { authMacro } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import { requireOnboarded } from "./middleware/onboarding";
import { securityHeaders } from "./middleware/security-headers";
import {
  clearSessionTokenCache,
  getSessionCached,
  invalidateSessionToken,
} from "./middleware/session-cache";
import { onboardingRoutes } from "./onboarding";
import { sharingRoutes } from "./sharing";
import { events } from "./realtime/events";
import { skillsRoutes } from "./skills";
import { replicache } from "./sync/replicache";
import { workflowRoutes } from "./workflows";

// The package's only entry point: no subpaths, because `exports` entries rot when files move.
// Nothing under `src/` may import this file back. The cycle boots only by export order,
// so a reorder becomes a TDZ error at startup. `.oxlintrc.json` enforces this.
// Importing it must read no env, so `auth()` is called per request in the mount.
export {
  authMacro,
  errorHandler,
  getSessionCached,
  invalidateSessionToken,
  requireOnboarded,
  securityHeaders,
};

export type { SecurityHeadersOptions } from "./middleware/security-headers";

// Importing any binding loads every route below. The whole graph must load with
// no env, DB or Redis, so keep module-scope side effects out.
// `test/barrel-load.test.ts` catches a missing read. No gate catches a module-scope
// timer or socket, because tests run with `--test-force-exit`.
export { agent, approvalsRoutes, chatRoutes, meRoutes };

export type { MeInboxItem, MeInboxMessage, MeLatestBriefing, MeMeetingItem } from "./me";

export {
  connections,
  integrationsRoutes,
  mcpIntegrationRoutes,
  onboardingRoutes,
  sharingRoutes,
  skillsRoutes,
  workflowRoutes,
};

// Realtime: only the SSE wire half lives here. A module stays in `@alfred/assistant/realtime`
// if it shares state with a background loop or the server starts or stops it (ADR-0089).
export { events };

// Replicache sync: protocol adaptation and row versions only, by the same rule.
// Domain decisions come from `@alfred/assistant` (ADR-0089).
export { replicache };

// The inferred `App` type names these, so the barrel must export them.
export type { PullResponse } from "./sync/pull";

export type { PushResponse } from "./sync/push";

/**
 * The Redis handle `/ready` pings, made on first request and reused.
 * `"command"`, not `"fail-fast"`: a fresh fail-fast handle always rejects its first ping.
 * It can report "ok" where a new connection would fail, e.g. at the client limit.
 */
let readyRedisConn: BoundedRedis | undefined;

function readyRedis(): BoundedRedis {
  readyRedisConn ??= createRedisConnection("command");

  return readyRedisConn;
}

// `normalize: 'typebox'`: Elysia 1.4's `exact-mirror` cleaner logs a Union error for every
// `t.Optional` field. TypeBox `Value.Clean` is slower but works.
export const app = new Elysia({ name: "api", normalize: "typebox" })
  .use(errorHandler)
  .use(replicache)
  .use(events)
  .use(agent)
  .use(approvalsRoutes)
  .use(chatRoutes)
  .use(connections)
  .use(mcpIntegrationRoutes)
  .use(integrationsRoutes)
  .use(meRoutes)
  .use(onboardingRoutes)
  .use(sharingRoutes)
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

    try {
      await readyRedis().ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }

    const allOk = Object.values(checks).every((value) => value === "ok");

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
  .mount(async (request: Request) => {
    const response = await auth().handler(request);

    // Any Better Auth POST can change a session. The trailing slash excludes `/api/authz/...`.
    if (
      request.method === "POST" &&
      response.ok &&
      new URL(request.url).pathname.startsWith("/api/auth/")
    ) {
      clearSessionTokenCache();
    }

    return response;
  });

export type App = typeof app;
