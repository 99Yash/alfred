import { INTEGRATION_SLUGS } from "@alfred/contracts";
import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const loadIntegrationInput = z
  .object({
    slug: z.enum(INTEGRATION_SLUGS).refine((slug) => slug !== "system", {
      message: "system is always loaded and cannot be loaded as an integration",
    }),
  })
  .strict();

export const systemTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "load_integration",
    riskTier: "no_risk",
    description:
      "Load another integration's tools for future turns when the workflow allowlist permits it.",
    inputSchema: loadIntegrationInput,
    execute: async (input, ctx) => {
      const allowed = ctx.allowedIntegrations ?? [];
      if (allowed.length > 0 && !allowed.includes(input.slug)) {
        return {
          ok: false,
          status: "not_allowed",
          slug: input.slug,
          reason: "workflow_allowed_integrations_cap",
        };
      }

      return { ok: true, slug: input.slug };
    },
  }),
];
