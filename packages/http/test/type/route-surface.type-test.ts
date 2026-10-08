// Compile-only fixture: pins the mount prefix of every route the `@alfred/http` barrel exports.
// It never runs (`.type-test.ts` misses the `test` glob); `tsconfig.test.json` type-checks it.
// It does not pin the `{ auth: true }` guard: removing `.use(authMacro)` already fails
// the route module with TS2353. A route with no guard (webhooks) needs an `app.handle` test.

import {
  agent,
  approvalsRoutes,
  chatRoutes,
  events,
  integrationsRoutes,
  mcpIntegrationRoutes,
  meRoutes,
  onboardingRoutes,
  replicache,
  skillsRoutes,
  workflowRoutes,
} from "@alfred/http";
import { Elysia } from "elysia";

// The module sets its own prefix; Elysia carries it in the instance type.
// Exported to satisfy `noUnusedLocals`.
export const prefix: (typeof agent)["config"]["prefix"] = "/api/agent";

// Eden (`treaty<App>`) checks only routes with a typed web call site; these lines pin the rest.
export const approvalsPrefix: (typeof approvalsRoutes)["config"]["prefix"] = "/api/approvals";

// Web calls `/api/chat` with untyped `fetch`, so only this line pins it.
export const chatPrefix: (typeof chatRoutes)["config"]["prefix"] = "/api/chat";

export const mePrefix: (typeof meRoutes)["config"]["prefix"] = "/api/me";

export const onboardingPrefix: (typeof onboardingRoutes)["config"]["prefix"] = "/api/me/onboarding";

export const skillsPrefix: (typeof skillsRoutes)["config"]["prefix"] = "/api/skills";

export const workflowsPrefix: (typeof workflowRoutes)["config"]["prefix"] = "/api/workflows";

// The browser builds the MCP connect and authorize URLs by hand, so Eden misses them.
export const mcpPrefix: (typeof mcpIntegrationRoutes)["config"]["prefix"] = "/api/integrations/mcp";

export const integrationsPrefix: (typeof integrationsRoutes)["config"]["prefix"] =
  "/api/integrations";

// The web builds this SSE URL by hand. A wrong prefix gives a 404, and `EventSource`
// then closes for good with no reconnect.
export const eventsPrefix: (typeof events)["config"]["prefix"] = "/api/events";

// Pull, push, and pokes use hand-built URLs, so a wrong prefix silently stops all sync.
export const replicachePrefix: (typeof replicache)["config"]["prefix"] = "/api/replicache";

// The root app composes each route with `.use(...)`.
export const composed = new Elysia()
  .use(agent)
  .use(approvalsRoutes)
  .use(chatRoutes)
  .use(events)
  .use(meRoutes)
  .use(onboardingRoutes)
  .use(replicache)
  .use(skillsRoutes)
  .use(workflowRoutes)
  .use(mcpIntegrationRoutes)
  .use(integrationsRoutes);
