/**
 * The route surface `@alfred/http`'s barrel mounts, and how it depends on `NODE_ENV`.
 *
 * This module is the single statement of "which routes mount". Two suites read it:
 * `../root-app.test.ts`, which asserts the surface of the app it imported in its own
 * process, and `../route-surface-env.test.ts`, which spawns one child process per
 * `NODE_ENV` value and asserts each child's answer.
 *
 * ## Why the table is literal
 *
 * `packages/http/src/realtime/events.ts` mounts `POST /api/events/_demo` only when
 * `nodeEnv()` answers `"development"`, and `nodeEnv()` reads a zod enum with
 * `.default("development")` (`packages/env/src/server.ts`), so an *unrecognized* value
 * such as `"prod"` mounts the development route. `includesDevelopmentOnlyRoutes` is
 * hand-written for every row and `routeSurfaceFor` reads no environment, because an
 * expectation that called `nodeEnv()` would be tautological with the function under test:
 * it would agree with any future change to that fallback.
 *
 * This module imports no environment reader, so it does not add an
 * `@alfred/http -> @alfred/env` edge.
 *
 * ## What this detects, and what it does not
 *
 * The pair of suites detects a module-load environment read that changes **which routes
 * mount** — the shape `packages/http/src/realtime/events.ts` once had, where a
 * `serverEnv()` call sat inside an eager Elysia `.guard(hook, cb)` callback. A
 * module-load environment read inside a builder chain that changes **no** route — a guard
 * schema, a header value, a timeout — changes nothing in `app.routes` and stays
 * undetected here.
 */

/**
 * The complete ordered `"METHOD /path"` list, as `app.routes` reports it, including every
 * development-only entry. Order is part of the assertion: Elysia matches in mount order.
 */
export const ROUTE_SURFACE = [
  "POST /api/replicache/pull",
  "POST /api/replicache/push",
  "GET /api/replicache/events",
  "GET /api/events/",
  "POST /api/events/_demo",
  "GET /api/agent/workflows",
  "POST /api/agent/runs",
  "POST /api/agent/runs/:runId/replay",
  "GET /api/agent/runs/:runId",
  "POST /api/agent/runs/:runId/signal",
  "POST /api/approvals/:stagingId/decision",
  "POST /api/chat/transcribe",
  "POST /api/chat/attachments/upload",
  "GET /api/chat/attachments/:id/content",
  "POST /api/chat/runs/:runId/stop",
  "POST /api/chat/threads/:threadId/turn",
  "GET /api/integrations/google/connect",
  "GET /api/integrations/google/credentials",
  "DELETE /api/integrations/google/:id",
  "PATCH /api/integrations/google/:id/persona",
  "POST /api/integrations/google/:id/watch",
  "DELETE /api/integrations/google/:id/watch",
  "GET /api/integrations/google/:id/watch",
  "POST /api/integrations/google/:id/ingest",
  "GET /api/integrations/google/callback",
  "GET /api/integrations/github/connect",
  "GET /api/integrations/github/credentials",
  "DELETE /api/integrations/github/:id",
  "GET /api/integrations/github/callback",
  "GET /api/integrations/notion/connect",
  "GET /api/integrations/notion/credentials",
  "DELETE /api/integrations/notion/:id",
  "GET /api/integrations/notion/callback",
  "POST /api/integrations/railway/connect",
  "GET /api/integrations/railway/credentials",
  "DELETE /api/integrations/railway/:id",
  "GET /api/integrations/vercel/connect",
  "GET /api/integrations/vercel/credentials",
  "DELETE /api/integrations/vercel/:id",
  "GET /api/integrations/vercel/callback",
  "POST /webhooks/gmail",
  "POST /webhooks/github",
  "GET /api/integrations/mcp/connections",
  "GET /api/integrations/mcp/github/connect",
  "GET /api/integrations/mcp/connections/:id/reconsent",
  "GET /api/integrations/mcp/client-metadata",
  "GET /api/integrations/mcp/callback",
  "GET /api/integrations/tool-tiers",
  "GET /api/me/inbox",
  "GET /api/me/inbox/:documentId",
  "POST /api/me/inbox/mark-read",
  "GET /api/me/meetings",
  "GET /api/me/briefings/latest",
  "POST /api/me/briefings/run",
  "GET /api/me/usage/summary",
  "GET /api/me/usage/breakdown",
  "GET /api/me/usage/activity",
  "GET /api/me/onboarding/",
  "POST /api/me/onboarding/complete",
  "POST /api/skills/",
  "POST /api/skills/:id/relearn",
  "POST /api/workflows/:id/recovery",
  "GET /health",
  "GET /ready",
  "GET /api/auth/get-session",
  "ALL /*",
] as const satisfies readonly string[];

/** The entries that mount only when `nodeEnv()` answers `"development"`. */
export const DEVELOPMENT_ONLY_ROUTES = [
  "POST /api/events/_demo",
] as const satisfies readonly string[];

/** One `NODE_ENV` value and the route surface it must produce. */
export type RouteSurfaceCase = {
  /** Names the row in a test title and in an assertion message. */
  readonly label: string;
  /** `undefined` means the variable is absent from the child environment. */
  readonly nodeEnv: string | undefined;
  /** Hand-written per row. Never derived from `nodeEnv()`. */
  readonly includesDevelopmentOnlyRoutes: boolean;
};

/**
 * The pinned set of `NODE_ENV` values. `unrecognized` is the row that matters: it is the
 * case item 06 measured, where the schema default turns an invalid value into
 * `"development"` and mounts a development-only write endpoint.
 */
export const ROUTE_SURFACE_CASES = [
  { label: "absent", nodeEnv: undefined, includesDevelopmentOnlyRoutes: true },
  { label: "development", nodeEnv: "development", includesDevelopmentOnlyRoutes: true },
  { label: "test", nodeEnv: "test", includesDevelopmentOnlyRoutes: false },
  { label: "production", nodeEnv: "production", includesDevelopmentOnlyRoutes: false },
  { label: "unrecognized", nodeEnv: "prod", includesDevelopmentOnlyRoutes: true },
] as const satisfies readonly RouteSurfaceCase[];

/**
 * The `unrecognized` row, named so a reader in another process can fall back to it.
 * Any value outside the enum takes the schema default, so this row describes them all.
 */
export const UNRECOGNIZED_NODE_ENV_CASE: RouteSurfaceCase = ROUTE_SURFACE_CASES[4];

/** The exact ordered surface the row expects. Reads no environment. */
export function routeSurfaceFor(testCase: RouteSurfaceCase): readonly string[] {
  if (testCase.includesDevelopmentOnlyRoutes) return ROUTE_SURFACE;
  const developmentOnly: readonly string[] = DEVELOPMENT_ONLY_ROUTES;
  return ROUTE_SURFACE.filter((route) => !developmentOnly.includes(route));
}

/**
 * The row that describes the ambient `NODE_ENV` of the current process, for a suite that
 * asserts the surface of an app it imported itself. An unrecognized value has no row of
 * its own, so it falls back to the row that shares its behavior.
 */
export function ambientRouteSurfaceCase(): RouteSurfaceCase {
  const ambient = process.env.NODE_ENV;
  return (
    ROUTE_SURFACE_CASES.find((testCase) => testCase.nodeEnv === ambient) ??
    UNRECOGNIZED_NODE_ENV_CASE
  );
}
