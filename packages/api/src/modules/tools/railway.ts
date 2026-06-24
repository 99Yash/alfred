/**
 * Railway tools (read + write). Reads enumerate projects/services, deployments,
 * and logs; `redeploy` re-runs a deployment and is the one infra-mutating tool
 * here (tier `high` — a UX hint; the policy gate is the real control). All
 * resolve the user's pasted Railway API token(s) via the shared credential
 * layer; follow-up tools act through a specific credential (provenance),
 * defaulting to the sole connection when only one is connected.
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
import {
  listActiveBearerCredentials,
  type ActiveBearerCredential,
} from "@alfred/integrations/shared";
import {
  credentialRef,
  listProjectsForCredentials,
  pickCredential,
  withCredential,
  type RailwayDeploymentWithCredential,
} from "./railway-fanout";
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

async function credentialFor(
  userId: string,
  credentialId?: string,
): Promise<ActiveBearerCredential> {
  return pickCredential(await credentialsFor(userId), credentialId);
}

export const railwayTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "railway",
    action: "list_projects",
    riskTier: "no_risk",
    description:
      "List the Railway projects across every connected credential, each tagged with its credentialId. Use this first to resolve project/service/environment ids — and the credentialId — for the other Railway tools.",
    inputSchema: railwayListProjectsInput,
    execute: async (_input, ctx) => {
      const { projects, failures } = await listProjectsForCredentials(
        await credentialsFor(ctx.userId),
        railwayListProjects,
      );
      // Surface partial failures (e.g. a stale credential) so the boss can tell
      // the user, but keep the happy-path output lean when nothing failed.
      return failures.length > 0 ? { projects, failures } : { projects };
    },
  }),
  liveTool({
    integration: "railway",
    action: "list_deployments",
    riskTier: "no_risk",
    description:
      "List recent deployments for a Railway project, with status and id. Pass the credentialId from list_projects (omit if only one Railway connection exists). Narrow with serviceId or environmentId. Use the returned credentialId and deployment id with get_logs or redeploy.",
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
      "Read recent logs for a Railway deployment. Pass the credentialId and deployment id from list_deployments (credentialId is optional when only one Railway connection exists).",
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
      "Redeploy an existing Railway deployment (re-runs the same build/release). Pass the credentialId and deployment id from list_deployments (credentialId is optional when only one Railway connection exists). Also pass serviceName, projectName, and (when known) environmentName from list_projects — these name what is being redeployed on the human approval card; redeploy always requires approval, so omitting them leaves the approver staring at opaque ids.",
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
