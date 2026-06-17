/**
 * Railway tools (read + write). Reads enumerate projects/services, deployments,
 * and logs; `redeploy` re-runs a deployment and is the one infra-mutating tool
 * here (tier `high` — a UX hint; the policy gate is the real control). All
 * resolve the user's pasted Railway API token via the shared credential layer.
 */

import {
  railwayGetLogsInput,
  railwayListDeploymentsInput,
  railwayListProjectsInput,
  railwayRedeployInput,
} from "@alfred/contracts";
import {
  railwayGetLogs,
  railwayListDeployments,
  railwayListProjects,
  railwayRedeploy,
} from "@alfred/integrations/railway";
import { getActiveBearerCredential } from "@alfred/integrations/shared";
import { liveTool, type RegisteredTool } from "./registry";

async function tokenFor(userId: string): Promise<string> {
  const { accessToken } = await getActiveBearerCredential(userId, "railway");
  return accessToken;
}

export const railwayTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "railway",
    action: "list_projects",
    riskTier: "no_risk",
    description:
      "List the Railway projects the connected account can access, each with its services and environments. Use this first to resolve project/service/environment ids for the other Railway tools.",
    inputSchema: railwayListProjectsInput,
    execute: async (_input, ctx) => {
      const token = await tokenFor(ctx.userId);
      return railwayListProjects(token);
    },
  }),
  liveTool({
    integration: "railway",
    action: "list_deployments",
    riskTier: "no_risk",
    description:
      "List recent deployments for a Railway project, with status and id. Narrow with serviceId or environmentId. Use the returned deployment id with get_logs or redeploy.",
    inputSchema: railwayListDeploymentsInput,
    execute: async (input, ctx) => {
      const token = await tokenFor(ctx.userId);
      return railwayListDeployments({
        token,
        projectId: input.projectId,
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        limit: input.limit,
      });
    },
  }),
  liveTool({
    integration: "railway",
    action: "get_logs",
    riskTier: "no_risk",
    description: "Read recent logs for a Railway deployment by deployment id.",
    inputSchema: railwayGetLogsInput,
    execute: async (input, ctx) => {
      const token = await tokenFor(ctx.userId);
      return railwayGetLogs({ token, deploymentId: input.deploymentId, limit: input.limit });
    },
  }),
  liveTool({
    integration: "railway",
    action: "redeploy",
    riskTier: "high",
    description:
      "Redeploy an existing Railway deployment (re-runs the same build/release). Pass the deployment id from list_deployments.",
    inputSchema: railwayRedeployInput,
    execute: async (input, ctx) => {
      const token = await tokenFor(ctx.userId);
      return railwayRedeploy({ token, deploymentId: input.deploymentId });
    },
  }),
];
