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
import { approvalsRoutes } from "./modules/approvals/index.js";
import { chatRoutes } from "./modules/chat/index.js";
import { integrations } from "./modules/integrations/index.js";
import { meRoutes } from "./modules/me/index.js";
import { onboardingRoutes } from "./modules/onboarding/index.js";
import { skillsRoutes } from "./modules/skills/index.js";

export { closeConnections, warmPool } from "@alfred/db";
export { closeRedis } from "./queue/connection.js";
export { initEventBridge, closeEventBridge } from "./events/index.js";
export {
  initReplicachePokeBridge,
  closeReplicachePokeBridge,
  emitReplicachePokes,
} from "./events/replicache-events.js";
export { publishEvent } from "./events/publish.js";
export type { EventFrame, EventKind, EventPayload } from "./events/types.js";
export { registerOnUserCreated, type OnUserCreatedHook } from "@alfred/auth";
export {
  registerWorkflow,
  startAgentWorker,
  stopAgentWorker,
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
  closeAgentQueue,
  closeSubAgentJoinWakeQueue,
  createRun,
  isUniqueViolation,
  signalRun,
  cancelRun,
  enqueueRun,
  getAgentQueue,
  verifyMeteringModels,
} from "./modules/agent/index.js";
export { chatTurnWorkflow, CHAT_TURN_WORKFLOW_SLUG } from "./modules/agent/workflows/chat-turn.js";
export {
  userAuthoredBriefWorkflow,
  USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
} from "./modules/agent/workflows/user-authored-brief.js";
export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  getIngestionQueue,
  scheduleRepeatableIngestionJobs,
} from "./modules/integrations/index.js";
export type { IngestionJobData } from "./modules/integrations/index.js";
export * from "./modules/integrations/object-state/index.js";
export * from "./modules/memory/index.js";
export * from "./modules/drift-audit/index.js";
export * from "./modules/triage/index.js";
export { suggestTodo } from "./modules/todos/suggest.js";
export type { SuggestTodoInput, SuggestTodoResult } from "./modules/todos/suggest.js";
export { getFeatureFlag, resolveFeatureFlags } from "./modules/features/flags.js";
export type { FeatureFlags } from "./modules/features/flags.js";
export * from "./modules/briefing/index.js";
export * from "./modules/cold-start/index.js";
export * from "./modules/notifications/index.js";
export * from "./modules/action-policies/index.js";
export * from "./modules/scratchpad/index.js";
export * from "./modules/tools/index.js";
export * from "./modules/dispatch/index.js";
export * from "./modules/skills/index.js";
export * from "./modules/skill-documentation/index.js";
export * from "./modules/workflows/index.js";
export * from "./modules/approvals/index.js";
export * from "./modules/me/index.js";
export {
  compactTranscript,
  assertHandoffSections,
  COMPACTOR_SYSTEM_PROMPT,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type CompactTranscriptArgs,
  type CompactTranscriptResult,
  type HandoffSection,
} from "./modules/agent/compaction/index.js";
export type {
  Workflow,
  WorkflowInput,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  RunStatus,
} from "./modules/agent/index.js";

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
  .use(integrations)
  .use(meRoutes)
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

    let conn: ReturnType<typeof createUntrackedRedisConnection> | undefined;
    try {
      conn = createUntrackedRedisConnection();
      await conn.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    } finally {
      // Untracked connection — close it here so a failing probe can't leak a
      // perpetually-reconnecting socket. quit() can reject if already broken;
      // fall back to a hard disconnect.
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
