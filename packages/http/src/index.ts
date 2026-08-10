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
// module-evaluation unit: importing ANY binding above also evaluates every
// route module below, and everything those modules reach, transitively. So the
// whole graph must load with no environment variable, no database and no Redis,
// and must retain no handles once loaded — keep module-scope side effects out of
// anything added here and out of anything it imports. The detector is the
// `http-tests` CI job, which imports this barrel with no service containers and
// no `env:` block. It is tier 4: it reports a module-scope read of something
// that is not there, it does not prevent one, and it says nothing about how wide
// the graph became. If you need that width, measure the resolved-module graph on
// both sides of your change — an export count cannot see it, and neither can the
// package you happened to declare. Do not restate either fact as a list of what
// the routes reach: an enumeration in this position is the one prose shape no
// gate maintains.
export { agent } from "./agent";
export { approvalsRoutes } from "./approvals";
export { chatRoutes } from "./conversations";
export { onboardingRoutes } from "./onboarding";
export { skillsRoutes } from "./skills";
export { workflowRoutes } from "./workflows";
