/**
 * Vercel tools (read + write). Reads list projects and deployments; `redeploy`
 * re-deploys an existing deployment (tier `high`). Team installs require every
 * call to echo `teamId`, which we read from the credential metadata captured at
 * connect.
 */

import {
  vercelListDeploymentsInput,
  vercelListProjectsInput,
  vercelRedeployInput,
} from "@alfred/contracts";
import {
  vercelListDeployments,
  vercelListProjects,
  vercelRedeploy,
} from "@alfred/integrations/vercel";
import { getActiveBearerCredential } from "@alfred/integrations/shared";
import { liveTool, type RegisteredTool } from "./registry";

async function credentialFor(
  userId: string,
): Promise<{ accessToken: string; teamId: string | null }> {
  const { accessToken, metadata } = await getActiveBearerCredential(userId, "vercel");
  const teamId = typeof metadata.team_id === "string" ? metadata.team_id : null;
  return { accessToken, teamId };
}

export const vercelTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "vercel",
    action: "list_projects",
    riskTier: "no_risk",
    description:
      "List Vercel projects for the connected account/team, with framework and latest deployment state.",
    inputSchema: vercelListProjectsInput,
    execute: async (input, ctx) => {
      const { accessToken, teamId } = await credentialFor(ctx.userId);
      return vercelListProjects({ accessToken, teamId, limit: input.limit });
    },
  }),
  liveTool({
    integration: "vercel",
    action: "list_deployments",
    riskTier: "no_risk",
    description:
      "List recent Vercel deployments, optionally scoped to a project, with state, target, and url. Use the returned uid as the deploymentId for redeploy.",
    inputSchema: vercelListDeploymentsInput,
    execute: async (input, ctx) => {
      const { accessToken, teamId } = await credentialFor(ctx.userId);
      return vercelListDeployments({
        accessToken,
        teamId,
        projectId: input.projectId,
        limit: input.limit,
      });
    },
  }),
  liveTool({
    integration: "vercel",
    action: "redeploy",
    riskTier: "high",
    description:
      "Redeploy an existing Vercel deployment. Pass the deployment uid and the project name; target defaults to the original deployment's target.",
    inputSchema: vercelRedeployInput,
    execute: async (input, ctx) => {
      const { accessToken, teamId } = await credentialFor(ctx.userId);
      return vercelRedeploy({
        accessToken,
        teamId,
        deploymentId: input.deploymentId,
        name: input.name,
        target: input.target,
      });
    },
  }),
];
