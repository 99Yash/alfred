import { readIntegrationStatus } from "@alfred/assistant/connections";
import { riskTierCountsForIntegration } from "@alfred/assistant/tool-runtime";
import { LOADABLE_INTEGRATION_SLUGS, type RiskTierCounts } from "@alfred/contracts";
import { Elysia } from "elysia";
import { authMacro } from "./middleware/auth";

/**
 * `/api/integrations`: the reads the integrations UI makes about the catalog as
 * a whole. One module owns the prefix; the per-provider connect and disconnect
 * families mount under `/api/integrations/<provider>` from `./connections`, and
 * the MCP surface under `/api/integrations/mcp`.
 *
 *   GET /api/integrations             → registry ⋈ credentials ⋈ connected rule (ADR-0093)
 *   GET /api/integrations/tool-tiers  → capability-tier counts per loadable slug
 *
 * The status join is assistant behavior and lives in
 * `@alfred/assistant/connections`; this route is its transport (ADR-0089).
 *
 * Auth only, no `requireOnboarded`. Onboarding step 2 reads the status for its
 * "connected as …" badges before `user.onboarded_at` is set, and the Google and
 * GitHub connect routes are open to an onboarding user for the same reason. The
 * bearer providers' routes are not, so this read is the first place an
 * onboarding user can see a Notion, Railway, or Vercel connection. The body
 * holds credential ids, account ids, and labels only.
 */
export const integrationsRoutes = new Elysia({
  prefix: "/api/integrations",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/", ({ user }) => readIntegrationStatus(user.id))
      .get("/tool-tiers", () => {
        const tiers: Record<string, RiskTierCounts> = {};
        for (const slug of LOADABLE_INTEGRATION_SLUGS) {
          tiers[slug] = riskTierCountsForIntegration(slug);
        }
        return { tiers };
      }),
  );
