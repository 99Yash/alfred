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
  type RailwayDeployment,
  type RailwayProject,
  railwayRedeploy,
} from "@alfred/integrations/railway";
import {
  listActiveBearerCredentials,
  type ActiveBearerCredential,
} from "@alfred/integrations/shared";
import { liveTool, type RegisteredTool } from "./registry";

interface RailwayCredentialRef {
  credentialId: string;
  credentialLabel: string;
  credentialAccountId: string;
}

type RailwayProjectWithCredential = RailwayProject & RailwayCredentialRef;
type RailwayDeploymentWithCredential = RailwayDeployment & RailwayCredentialRef;

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

function credentialRef(credential: ActiveBearerCredential): RailwayCredentialRef {
  return {
    credentialId: credential.id,
    credentialLabel: credentialLabel(credential),
    credentialAccountId: credential.accountId,
  };
}

function withCredential<T extends object>(
  value: T,
  credential: ActiveBearerCredential,
): T & RailwayCredentialRef {
  return { ...value, ...credentialRef(credential) };
}

async function credentialFor(
  userId: string,
  credentialId: string,
): Promise<ActiveBearerCredential> {
  const credentials = await credentialsFor(userId);
  const credential = credentials.find((c) => c.id === credentialId);
  if (!credential) {
    throw new Error(
      `[railway.credentials] Railway credential '${credentialId}' is not active or connected`,
    );
  }
  return credential;
}

async function listProjectsAcrossCredentials(
  userId: string,
): Promise<{ projects: RailwayProjectWithCredential[] }> {
  const credentials = await credentialsFor(userId);
  const projectsById = new Map<string, RailwayProjectWithCredential>();
  const failures: string[] = [];
  for (const credential of credentials) {
    try {
      const result = await railwayListProjects(credential.accessToken);
      for (const project of result.projects) {
        if (!projectsById.has(project.id))
          projectsById.set(project.id, withCredential(project, credential));
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
      "List recent deployments for a Railway project, with status and id. Pass the credentialId from list_projects. Narrow with serviceId or environmentId. Use the returned credentialId and deployment id with get_logs or redeploy.",
    inputSchema: railwayListDeploymentsInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId, input.credentialId);
      const result = await railwayListDeployments({
        token: credential.accessToken,
        projectId: input.projectId,
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        limit: input.limit,
      });
      return {
        deployments: result.deployments.map(
          (deployment): RailwayDeploymentWithCredential => withCredential(deployment, credential),
        ),
      };
    },
  }),
  liveTool({
    integration: "railway",
    action: "get_logs",
    riskTier: "no_risk",
    description:
      "Read recent logs for a Railway deployment. Pass the credentialId and deployment id from list_deployments.",
    inputSchema: railwayGetLogsInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId, input.credentialId);
      const result = await railwayGetLogs({
        token: credential.accessToken,
        deploymentId: input.deploymentId,
        limit: input.limit,
      });
      return { ...credentialRef(credential), ...result };
    },
  }),
  liveTool({
    integration: "railway",
    action: "redeploy",
    riskTier: "high",
    description:
      "Redeploy an existing Railway deployment (re-runs the same build/release). Pass the credential id and deployment id from list_deployments.",
    inputSchema: railwayRedeployInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId, input.credentialId);
      const result = await railwayRedeploy({
        token: credential.accessToken,
        deploymentId: input.deploymentId,
      });
      return { ...credentialRef(credential), ...result };
    },
  }),
];
