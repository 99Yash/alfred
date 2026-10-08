import { readIntegrationStatus, readRawReceiptInventory } from "@alfred/assistant/connections";
import { riskTierCountsForIntegration } from "@alfred/assistant/tool-runtime";
import {
  Errors,
  isLiveProviderSlug,
  LOADABLE_INTEGRATION_SLUGS,
  type RiskTierCounts,
} from "@alfred/contracts";
import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";

/**
 * Catalog-wide reads for the integrations UI (ADR-0093, ADR-0097).
 * `raw-kinds/:slug` uses a static first segment so it cannot shadow a provider's routes.
 * No `requireOnboarded`: onboarding step 2 reads the status before `onboarded_at` is set.
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
      })
      .get(
        "/raw-kinds/:slug",
        ({ user, params }) => {
          // A planned provider has no credentials, so it has no receipts.
          if (!isLiveProviderSlug(params.slug)) throw Errors.NotFoundError("Unknown integration");

          return readRawReceiptInventory(user.id, params.slug);
        },
        { params: t.Object({ slug: t.String({ minLength: 1 }) }) },
      ),
  );
