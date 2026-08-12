import { riskTierCountsForIntegration } from "@alfred/assistant/tool-runtime";
import { LOADABLE_INTEGRATION_SLUGS, type RiskTierCounts } from "@alfred/contracts";
import { Elysia } from "elysia";
import { authMacro } from "./middleware/auth";

/** Authenticated capability-tier summary for the integrations UI. */
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
