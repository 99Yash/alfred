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
