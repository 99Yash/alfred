/**
 * The routes the `@alfred/http` barrel mounts, per `NODE_ENV`.
 * `POST /api/events/_demo` mounts when `nodeEnv()` is `"development"`, and an invalid value
 * such as `"prod"` falls back to it. Expectations are hand-written and read no env:
 * calling `nodeEnv()` here would agree with any change to that fallback.
 * Catches a module-load env read that changes which routes mount, not one that changes no route.
 */

/** Ordered `"METHOD /path"` list from `app.routes`. Order matters: Elysia matches in mount order. */
const ROUTE_SURFACE = [
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
  "DELETE /api/integrations/google/:id",
  "PATCH /api/integrations/google/:id/persona",
  "POST /api/integrations/google/:id/watch",
  "DELETE /api/integrations/google/:id/watch",
  "GET /api/integrations/google/:id/watch",
  "POST /api/integrations/google/:id/ingest",
  "GET /api/integrations/google/callback",
  "GET /api/integrations/github/connect",
  "DELETE /api/integrations/github/:id",
  "GET /api/integrations/github/callback",
  "GET /api/integrations/notion/connect",
  "DELETE /api/integrations/notion/:id",
  "GET /api/integrations/notion/callback",
  "POST /api/integrations/sentry/connect",
  "DELETE /api/integrations/sentry/:id",
  "GET /api/integrations/vercel/connect",
  "DELETE /api/integrations/vercel/:id",
  "GET /api/integrations/vercel/callback",
  "POST /webhooks/gmail",
  "POST /webhooks/inbound/:source",
  "POST /webhooks/github",
  "GET /api/integrations/mcp/connections",
  "POST /api/integrations/mcp/connections",
  "GET /api/integrations/mcp/recovery",
  "POST /api/integrations/mcp/recovery/:invocationId/resolve",
  "POST /api/integrations/mcp/recovery/:invocationId/successor",
  "GET /api/integrations/mcp/built-ins/:provider/connect",
  "GET /api/integrations/mcp/connections/:id/authorize",
  "GET /api/integrations/mcp/connections/:id/reconsent",
  "POST /api/integrations/mcp/connections/:id/reconnect",
  "POST /api/integrations/mcp/connections/:id/disconnect",
  "PATCH /api/integrations/mcp/connections/:id",
  "DELETE /api/integrations/mcp/connections/:id",
  "GET /api/integrations/mcp/connections/:id/tools",
  "GET /api/integrations/mcp/connections/:id/tools/inspect",
  "GET /api/integrations/mcp/connections/:id/tools/policy",
  "PUT /api/integrations/mcp/connections/:id/tools/policy",
  "DELETE /api/integrations/mcp/connections/:id/tools/policy",
  "GET /api/integrations/mcp/connections/:id/tools/health-mapping",
  "PUT /api/integrations/mcp/connections/:id/tools/health-mapping",
  "DELETE /api/integrations/mcp/connections/:id/tools/health-mapping",
  "GET /api/integrations/mcp/client-metadata",
  "GET /api/integrations/mcp/callback",
  "GET /api/integrations/",
  "GET /api/integrations/tool-tiers",
  "GET /api/integrations/raw-kinds/:slug",
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
  "GET /api/shared/:urlSlug",
  "POST /api/threads/:threadId/share",
  "GET /api/threads/:threadId/shares",
  "DELETE /api/shares/:sharedThreadId",
  "POST /api/skills/",
  "POST /api/skills/:id/relearn",
  "GET /api/workflows/:id/runs",
  "POST /api/workflows/:id/recovery",
  "GET /health",
  "GET /ready",
  "GET /api/auth/get-session",
  "ALL /*",
] as const satisfies readonly string[];

const DEVELOPMENT_ONLY_ROUTES = ["POST /api/events/_demo"] as const satisfies readonly string[];

export type RouteSurfaceCase = {
  readonly label: string;
  /** `undefined` means the variable is absent from the child environment. */
  readonly nodeEnv: string | undefined;
  /** Hand-written per row. Never derived from `nodeEnv()`. */
  readonly includesDevelopmentOnlyRoutes: boolean;
};

/** `unrecognized` matters most: the schema default turns it into `"development"`. */
export const ROUTE_SURFACE_CASES = [
  { label: "absent", nodeEnv: undefined, includesDevelopmentOnlyRoutes: true },
  { label: "development", nodeEnv: "development", includesDevelopmentOnlyRoutes: true },
  { label: "test", nodeEnv: "test", includesDevelopmentOnlyRoutes: false },
  { label: "production", nodeEnv: "production", includesDevelopmentOnlyRoutes: false },
  { label: "unrecognized", nodeEnv: "prod", includesDevelopmentOnlyRoutes: true },
] as const satisfies readonly RouteSurfaceCase[];

const UNRECOGNIZED_NODE_ENV_LABEL = "unrecognized";

/** Look up by label, not index, so an inserted row cannot silently rebind the lookup. */
function routeSurfaceCaseByLabel(label: string): RouteSurfaceCase {
  const found = ROUTE_SURFACE_CASES.find((testCase) => testCase.label === label);

  if (found === undefined) {
    throw new Error(`the route surface table holds no row labelled "${label}"`);
  }

  return found;
}

/** The exact ordered surface the row expects. Reads no environment. */
export function routeSurfaceFor(testCase: RouteSurfaceCase): readonly string[] {
  if (testCase.includesDevelopmentOnlyRoutes) return ROUTE_SURFACE;
  const developmentOnly: readonly string[] = DEVELOPMENT_ONLY_ROUTES;

  return ROUTE_SURFACE.filter((route) => !developmentOnly.includes(route));
}

/** The row for this process's `NODE_ENV`. An unrecognized value uses the `unrecognized` row. */
export function ambientRouteSurfaceCase(): RouteSurfaceCase {
  const ambient = process.env.NODE_ENV;

  return (
    ROUTE_SURFACE_CASES.find((testCase) => testCase.nodeEnv === ambient) ??
    routeSurfaceCaseByLabel(UNRECOGNIZED_NODE_ENV_LABEL)
  );
}
