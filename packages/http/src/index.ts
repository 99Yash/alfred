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
export { agent } from "./agent";
export { approvalsRoutes } from "./approvals";
export { chatRoutes } from "./conversations";
export { onboardingRoutes } from "./onboarding";
export { skillsRoutes } from "./skills";
export { workflowRoutes } from "./workflows";

// Realtime push. `realtime/` is a non-domain subdirectory, like `middleware/`:
// the flat `src/<domain>.ts` layout names product domains, and SSE delivery is
// a transport concern that several domains push through. Only the wire half
// lives here — frame encoding, heartbeats, `Last-Event-ID` replay handoff. The
// substrate underneath it lives on `@alfred/assistant/realtime` and this route
// imports it. Where the line falls is not decided by counting callers: today
// most of that substrate is reached by this route alone, and pulling it across
// on that basis is the mistake to avoid. Two properties decide it instead.
// A module stays out if it shares mutable state or a written invariant with a
// background loop — the outbox reader and the retention reaper agree on one
// retention window, and a Redis bus's subscribe half agrees with its publish
// half on one channel name; split either pair across a package boundary and
// the invariant has two owners and no checker. And a module stays out if the
// server's lifecycle starts or stops it, because ADR-0089 fixes that direction
// at `apps/server -> @alfred/assistant/runtime`, which does not pass through
// transport. What is left — code that only exists because a client speaks HTTP
// — is what belongs here.
export { events } from "./realtime/events";
