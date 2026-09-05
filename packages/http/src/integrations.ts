import { readIntegrationStatus } from "@alfred/assistant/connections";
import { Elysia } from "elysia";
import { authMacro } from "./middleware/auth";

/**
 * `GET /api/integrations`: the registry joined with the user's credentials and
 * resolved through the connected rule (ADR-0093), one read for every web surface
 * that shows connection state (tiles, detail pages, chat connect nudges, the
 * scope-gap and reconnect banners). The join is assistant behavior and lives in
 * `@alfred/assistant/connections`; this route is its transport (ADR-0089).
 *
 * Auth only, no `requireOnboarded`: the onboarding steps read it for the
 * "connected as …" badges before `user.onboarded_at` is set, as the per-provider
 * `/credentials` routes already allow.
 */
export const integrationsRoutes = new Elysia({
  prefix: "/api/integrations",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) => app.get("/", ({ user }) => readIntegrationStatus(user.id)));
