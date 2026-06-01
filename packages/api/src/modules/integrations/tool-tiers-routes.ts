import { LOADABLE_INTEGRATION_SLUGS } from "@alfred/contracts";
import { Elysia } from "elysia";
import { authMacro } from "../../middleware/auth";
import { type RiskTierCounts, riskTierCountsForIntegration } from "../tools";

/**
 * Tool-tier summary route.
 *
 *   GET /api/integrations/tool-tiers → per-integration risk-tier counts
 *
 * The registry is a server-only singleton (the web bundle can't import it),
 * so the integration detail page reads tier counts from here to render its
 * "Gmail — 3 tools (1 high, 1 medium, 1 no-risk)" summary. Counts are a UX
 * hint, not the gate — gating is `user_action_policies` (ADR-0034). The
 * registry is static after boot, so this is user-independent; auth only
 * keeps it off the public surface.
 */
export const toolTiersRoutes = new Elysia({
  prefix: "/api/integrations",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app.get("/tool-tiers", () => {
      const tiers: Record<string, RiskTierCounts> = {};
      for (const slug of LOADABLE_INTEGRATION_SLUGS) {
        tiers[slug] = riskTierCountsForIntegration(slug);
      }
      return { tiers };
    }),
  );
