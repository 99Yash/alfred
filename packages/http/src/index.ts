import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { agent } from "./agent";
import { approvalsRoutes } from "./approvals";
import { chatRoutes } from "./conversations";
import { connections } from "./connections";
import { mcpIntegrationRoutes } from "./mcp";
import { meRoutes } from "./me";
import { authMacro } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import { securityHeaders } from "./middleware/security-headers";
import { getSessionCached, invalidateSessionToken } from "./middleware/session-cache";
import { onboardingRoutes } from "./onboarding";
import { events } from "./realtime/events";
import { skillsRoutes } from "./skills";
import { ENTITY_FETCHERS } from "./sync/entities";
import { replicache } from "./sync/replicache";
import { toolTiersRoutes } from "./tool-tiers";
import { workflowRoutes } from "./workflows";

// `@alfred/http` owns the transport layer. This is its one door — a single `.`
// barrel, no subpaths, because a concrete `exports` entry rots silently when a
// file moves and no repo gate reads the map (see
// `.lessons/moving-a-file-leaves-its-exports-entry-behind-and-no-gate-catches-it.md`).
//
// Nothing under `src/` may import this file back. Every module named below is
// re-exported here, so a return import closes an `index.ts -> that module ->
// index.ts` cycle, and the order of the export lines below is the only reason
// such a cycle boots at all — reorder them and it becomes a TDZ
// `ReferenceError` at startup, in the package whose job is to be imported
// first. Import the concrete sibling module instead. The `packages/http/src/**`
// override in `.oxlintrc.json` holds the rule: it fails `pnpm lint` on the
// `@alfred/http` specifier, on any subpath of it, and on every relative
// spelling of this file.
//
// This barrel also owns the composed root `app` and its derived `App` type.
// Importing it must stay environment-free, so the final Better Auth mount
// delegates through a request-time wrapper instead of calling `auth()` here.
export { authMacro, errorHandler, getSessionCached, invalidateSessionToken, securityHeaders };
export type { SecurityHeadersOptions } from "./middleware/security-headers";

// Routes. This is one barrel with no subpaths, so it is also one
// module-evaluation unit: importing ANY binding above also evaluates every
// route module below, and everything those modules reach, transitively. So the
// whole graph must load with no environment variable, no database and no Redis
// — keep module-scope side effects out of anything added here and out of
// anything it imports.
//
// The detector for that load requirement is `test/barrel-load.test.ts`, which
// exists as a file of its own so that no other test's import can quietly become
// the thing that checks it. It is tier 4 and it covers one clause: it reports a
// module-scope read of something that is not there, it does not prevent one.
// Two things nothing here reports. A handle retained at module scope — a timer,
// an open connection — is checked by no gate in this repo, because the package
// runs its tests with `--test-force-exit`; keep them out on the strength of the
// rule above, not on the strength of a green job. And how wide the graph
// became: if you need that, measure the resolved-module graph on both sides of
// your change, because an export count cannot see it and neither can the
// package you happened to declare. Do not restate any of this as a list of what
// the routes reach: an enumeration in this position is the one prose shape no
// gate maintains.
export { agent, approvalsRoutes, chatRoutes, meRoutes };
export type { MeInboxItem, MeInboxMessage, MeLatestBriefing, MeMeetingItem } from "./me";
export {
  connections,
  mcpIntegrationRoutes,
  onboardingRoutes,
  skillsRoutes,
  toolTiersRoutes,
  workflowRoutes,
};

// Realtime push. `realtime/` is a non-domain subdirectory, like `middleware/`:
// the flat `src/<domain>.ts` layout names product domains, and SSE delivery is
// a transport concern that several domains push through. Only the wire half
// lives here — frame encoding, heartbeats, `Last-Event-ID` replay handoff. The
// substrate underneath it lives on `@alfred/assistant/realtime` and this route
// imports it. Where the line falls is not decided by counting callers: parts
// of that substrate are reached by this route alone, and pulling them across
// on that basis is the mistake to avoid. Two properties decide it instead.
// A module stays out if it shares mutable state or a written invariant with a
// background loop — a Redis bus's subscribe half and its publish half agree on
// one `channelFor` name, and what the outbox reader can serve is bounded by
// what the retention reaper has already deleted; split either pair across a
// package boundary and the invariant has two owners and no checker. And a
// module stays out if the server's lifecycle starts or stops it, because
// ADR-0089 fixes that direction at `apps/server -> @alfred/assistant/runtime`,
// which does not pass through transport. What is left — code that only exists
// because a client speaks HTTP — is what belongs here.
export { events };

// Replicache sync. `sync/` is a third non-domain subdirectory, on the same
// rule as `middleware/` and `realtime/`: what lives here exists only because a
// client speaks a wire protocol. Membership is decided by the two properties
// stated above, not by counting callers — a module stays out if it shares
// mutable state or a written invariant with a background loop, and it stays
// out if the server's lifecycle starts or stops it. Applied to the Replicache
// server, both properties come back negative for the whole set: the CVR store
// is a lazy per-process cache that one request path writes and the same path
// reads, with no reaper and no relay behind it, and nothing under `sync/` is
// started or stopped by `apps/server`. The domain DECISIONS these adapters
// reach for — what a fact is worth keeping, what a preference means, what a
// workflow revision may become — all come from `@alfred/assistant`, and what
// is left here is protocol adaptation and row-version bookkeeping. That is
// also what ADR-0089 assigns to this package by name.
//
// `ENTITY_FETCHERS` is advertised for one reason: a workflow test in the legacy
// `@alfred/api` package asserts the sync projection of a revision it just wrote, and
// this package has no subpaths, so the barrel is its only door. It is the read
// half of the protocol, not a general-purpose map.
export { ENTITY_FETCHERS, replicache };

// Not optional and not a widening of intent: `/pull` and `/push` answer with
// these two types, so the inferred type of the root `app` names them. This
// package has no subpath the declaration could point at, so the one root barrel
// advertises both protocol response types with the app that uses them.
export type { PullResponse } from "./sync/pull";
export type { PushResponse } from "./sync/push";

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
  .mount((request: Request) => auth().handler(request));

export type App = typeof app;
