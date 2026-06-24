/**
 * Railway tools (read + write). Reads enumerate projects/services, deployments,
 * and logs; `redeploy` re-runs a deployment and is the one infra-mutating tool
 * here (tier `high` — a UX hint; the policy gate is the real control). All
 * resolve the user's pasted Railway API token via the shared credential layer.
 */

import {
  toMessage,
  railwayGetLogsInput,
  railwayListDeploymentsInput,
  railwayListProjectsInput,
  railwayRedeployInput,
} from "@alfred/contracts";
import {
  isRailwayAuthorizationError,
  railwayGetLogs,
  railwayListDeployments,
  railwayListProjects,
  type RailwayProject,
  railwayRedeploy,
} from "@alfred/integrations/railway";
import {
  listActiveBearerCredentials,
  type ActiveBearerCredential,
} from "@alfred/integrations/shared";
import { liveTool, type RegisteredTool } from "./registry";

async function credentialsFor(userId: string): Promise<ActiveBearerCredential[]> {
  const credentials = await listActiveBearerCredentials(userId, "railway");
  if (credentials.length === 0) {
    throw new Error(
      "[railway.credentials] no active Railway credential — connect Railway in settings",
    );
  }
  return credentials;
}

function credentialLabel(credential: ActiveBearerCredential): string {
  return credential.accountLabel ?? credential.accountId;
}

async function executeWithAnyRailwayCredential<T>(
  userId: string,
  run: (token: string) => Promise<T>,
): Promise<T> {
  const credentials = await credentialsFor(userId);
  const authorizationFailures: string[] = [];
  for (const credential of credentials) {
    try {
      return await run(credential.accessToken);
    } catch (err) {
      if (!isRailwayAuthorizationError(err)) throw err;
      authorizationFailures.push(credentialLabel(credential));
    }
  }
  throw new Error(
    `[railway.credentials] no connected Railway credential had access (${authorizationFailures.join(
      ", ",
    )})`,
  );
}

async function listProjectsAcrossCredentials(
  userId: string,
): Promise<{ projects: RailwayProject[] }> {
  const credentials = await credentialsFor(userId);
  const projectsById = new Map<string, RailwayProject>();
  const failures: string[] = [];
  for (const credential of credentials) {
    try {
      const result = await railwayListProjects(credential.accessToken);
      for (const project of result.projects) {
        if (!projectsById.has(project.id)) projectsById.set(project.id, project);
      }
    } catch (err) {
      if (!isRailwayAuthorizationError(err)) throw err;
      if (credentials.length === 1) throw err;
      failures.push(`${credentialLabel(credential)}: ${toMessage(err)}`);
    }
  }
  if (projectsById.size === 0 && failures.length > 0) {
    throw new Error(
      `[railway.credentials] no Railway credential could list projects: ${failures.join("; ")}`,
    );
  }
  return { projects: [...projectsById.values()] };
}

export const railwayTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "railway",
    action: "list_projects",
    riskTier: "no_risk",
    description:
      "List the Railway projects the connected credentials can access, each with its services and environments. Use this first to resolve project/service/environment ids for the other Railway tools.",
    inputSchema: railwayListProjectsInput,
    execute: async (_input, ctx) => {
      return listProjectsAcrossCredentials(ctx.userId);
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
      return executeWithAnyRailwayCredential(ctx.userId, (token) =>
        railwayListDeployments({
          token,
          projectId: input.projectId,
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          limit: input.limit,
        }),
      );
    },
  }),
  liveTool({
    integration: "railway",
    action: "get_logs",
    riskTier: "no_risk",
    description: "Read recent logs for a Railway deployment by deployment id.",
    inputSchema: railwayGetLogsInput,
    execute: async (input, ctx) => {
      return executeWithAnyRailwayCredential(ctx.userId, (token) =>
        railwayGetLogs({ token, deploymentId: input.deploymentId, limit: input.limit }),
      );
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
      return executeWithAnyRailwayCredential(ctx.userId, (token) =>
        railwayRedeploy({ token, deploymentId: input.deploymentId }),
      );
    },
  }),
];
