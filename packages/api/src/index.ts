import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { errorHandler } from "./middleware/error-handler.js";
import { getSessionCached, invalidateSessionToken } from "./middleware/session-cache.js";
import { createUntrackedRedisConnection } from "./queue/connection.js";
import { events } from "./modules/events/index.js";
import { replicache } from "./modules/replicache/index.js";
import { agent } from "./modules/agent/index.js";
import { integrations } from "./modules/integrations/index.js";
import { onboardingRoutes } from "./modules/onboarding/index.js";
import { skillsRoutes } from "./modules/skills/index.js";

export { closeConnections, warmPool } from "@alfred/db";
export { closeRedis } from "./queue/connection.js";
export { initEventBridge, closeEventBridge } from "./events/index.js";
export { initReplicachePokeBridge, closeReplicachePokeBridge } from "./events/replicache-events.js";
export { publishEvent } from "./events/publish.js";
export type { EventFrame, EventKind, EventPayload } from "./events/types.js";
export { registerOnUserCreated, type OnUserCreatedHook } from "@alfred/auth";
export {
  registerWorkflow,
  startAgentWorker,
  stopAgentWorker,
  closeAgentQueue,
  createRun,
  isUniqueViolation,
  signalRun,
  enqueueRun,
  getAgentQueue,
} from "./modules/agent/index.js";
export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  getIngestionQueue,
  scheduleRepeatableIngestionJobs,
} from "./modules/integrations/index.js";
export type { IngestionJobData } from "./modules/integrations/index.js";
export * from "./modules/memory/index.js";
export * from "./modules/triage/index.js";
export * from "./modules/briefing/index.js";
export * from "./modules/cold-start/index.js";
export * from "./modules/notifications/index.js";
export * from "./modules/action-policies/index.js";
export * from "./modules/scratchpad/index.js";
export * from "./modules/tools/index.js";
export * from "./modules/skills/index.js";
export * from "./modules/skill-documentation/index.js";
export * from "./modules/workflows/index.js";
export type {
  Workflow,
  WorkflowInput,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  RunStatus,
} from "./modules/agent/index.js";

export const app = new Elysia({ name: "api" })
  .use(errorHandler)
  .use(replicache)
  .use(events)
  .use(agent)
  .use(integrations)
  .use(onboardingRoutes)
  .use(skillsRoutes)
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
