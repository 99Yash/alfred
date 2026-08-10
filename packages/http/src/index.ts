// `@alfred/http` owns the transport layer. This is its one door — a single `.`
// barrel, no subpaths, because a concrete `exports` entry rots silently when a
// file moves and no repo gate reads the map (see
// `.lessons/moving-a-file-leaves-its-exports-entry-behind-and-no-gate-catches-it.md`).
//
// The transitional `export { app } from "@alfred/api"` that this file held is
// gone. It had to go in this slice: the middleware below still has 17 consumers
// under `packages/api/src`, so `@alfred/api -> @alfred/http` is now a real
// edge, and the re-export's opposite edge would close a package cycle that
// `scripts/check-module-architecture.mjs` rejects. `apps/server` keeps
// importing `app` straight from `@alfred/api` until campaign item 08 assembles
// the root app here.
export { authMacro } from "./middleware/auth";
export { errorHandler } from "./middleware/error-handler";
export { securityHeaders, type SecurityHeadersOptions } from "./middleware/security-headers";
export { getSessionCached, invalidateSessionToken } from "./middleware/session-cache";

// Routes. This is one barrel with no subpaths, so it is also one
// module-evaluation unit: importing ANY binding above now also evaluates all
// five route modules below — the agent route plus the four domain routes
// campaign item 05 moved across — and through them `drizzle-orm`, `@alfred/db`
// and every `@alfred/assistant` subpath they reach. That graph needs no
// environment variables and no database to load, re-probed after item 05's
// move with `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` and
// `OAUTH_CREDENTIAL_KEK` all unset, and `apps/server` already loads it through
// `@alfred/api`, so the cost is inert today — but keep module-scope side
// effects out of anything added here. Do not turn "what the routes reach" into
// a list: campaign items 24-27 add more, and an enumeration in this position
// is the one prose shape no gate maintains.
export { agent } from "./routes/agent";
export { approvalsRoutes } from "./approvals";
export { onboardingRoutes } from "./onboarding";
export { skillsRoutes } from "./skills";
export { workflowRoutes } from "./workflows";
