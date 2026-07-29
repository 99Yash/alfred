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
  railwayGraphqlInput,
  railwayListDeploymentsInput,
  railwayListProjectsInput,
  railwayRecentDeploymentsInput,
  railwayRedeployInput,
} from "@alfred/contracts";
import type { RailwayCredentialClient } from "@alfred/integrations/railway";
import { runRailwayPassthrough } from "./passthrough";
import { AppError } from "../../lib/app-errors";
import {
  credentialRef,
  listProjectsForCredentials,
  listRecentDeploymentsForCredentials,
  pickCredential,
  withCredential,
  type RailwayDeploymentWithCredential,
} from "./railway-fanout";
import { liveTool, type RegisteredTool, type ToolExecuteContext } from "./registry";

async function credentialsFor(ctx: ToolExecuteContext): Promise<RailwayCredentialClient[]> {
  const credentials = await ctx.integrations.railway.credentials();
  if (credentials.length === 0) {
    throw new AppError("railway_connection_required");
  }
  return credentials;
}

async function selectCredential(
  ctx: ToolExecuteContext,
  credentialId?: string,
): Promise<RailwayCredentialClient> {
  return pickCredential(await credentialsFor(ctx), credentialId);
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
      const credentials = await credentialsFor(ctx);
      const { projects, failures } = await listProjectsForCredentials(
        credentials,
        (credentialId) => {
          const credential = credentials.find((candidate) => candidate.id === credentialId);
          if (!credential) throw new AppError("railway_credential_required");
          return credential.listProjects();
        },
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
      const credential = await selectCredential(ctx, input.credentialId);
      const result = await credential.listDeployments({
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
    action: "recent_deployments",
    riskTier: "no_risk",
    description:
      "List the most recent deployments across ALL Railway projects and every connected credential, newest first — each tagged with its project, service, status, createdAt, and credentialId. Use this to answer 'what deployed recently' or to build an activity digest: it fans out across every project for you, so you never have to call list_projects and then list_deployments per project. Never claim there are no recent deployments without calling this first. To read one project's fuller deployment history (or a specific service/environment), use list_deployments; for a single deployment's logs, use get_logs.",
    inputSchema: railwayRecentDeploymentsInput,
    execute: async (input, ctx) => {
      const credentials = await credentialsFor(ctx);
      const { deployments, failures } = await listRecentDeploymentsForCredentials(
        credentials,
        (credentialId) => {
          const credential = credentials.find((candidate) => candidate.id === credentialId);
          if (!credential) throw new AppError("railway_credential_required");
          return credential.listProjects();
        },
        ({ credentialId, ...args }) => {
          const credential = credentials.find((candidate) => candidate.id === credentialId);
          if (!credential) throw new AppError("railway_credential_required");
          return credential.listDeployments(args);
        },
        { overallLimit: input.limit },
      );
      // Surface partial failures (a stale credential, a project that wouldn't
      // answer) so the boss can tell the user its view is incomplete, but keep
      // the happy-path output lean when nothing failed.
      return failures.length > 0 ? { deployments, failures } : { deployments };
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
      const credential = await selectCredential(ctx, input.credentialId);
      const result = await credential.getLogs({
        deploymentId: input.deploymentId,
        limit: input.limit,
      });
      return { ...credentialRef(credential), ...result };
    },
  }),
  liveTool({
    integration: "railway",
    action: "graphql",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Run a raw, READ-ONLY GraphQL query against Railway's public API (https://backboard.railway.app/graphql/v2) — the general-tier escape hatch for reads the curated Railway tools don't cover (service variables, plugin/volume details, usage, deployment metadata, workspace/team structure). Compose a standard GraphQL `query` document; pass `variables` and, only when the document defines more than one operation, `operationName`. Mutations and subscriptions are rejected at the boundary. To learn the schema, prefer a targeted `__type(name: \"Service\") { fields { name } }` introspection over a full `__schema` dump, which is truncated. This is a raw, unvalidated read: a non-2xx status, a GraphQL `errors[]`, or an empty result may mean your query was wrong — NOT that the thing is absent. Read both `data` and `errors` in the result. Correct the query once and retry if it looks wrong, otherwise state the uncertainty. Never report a raw empty as a confident zero. For 'what deployed recently', prefer the curated railway.recent_deployments.",
    discovery: {
      aliases: ["railway graphql", "railway api query", "query railway"],
      tags: ["infrastructure", "developer"],
      entities: ["service", "variable", "volume", "plugin", "usage", "workspace"],
      verbs: ["query", "read", "inspect", "introspect"],
    },
    inputSchema: railwayGraphqlInput,
    execute: async (input, ctx) => {
      const credential = await selectCredential(ctx);
      return runRailwayPassthrough((request) => credential.graphqlRaw(request), input);
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
      const credential = await selectCredential(ctx, input.credentialId);
      const result = await credential.redeploy({
        deploymentId: input.deploymentId,
      });
      return { ...credentialRef(credential), ...result };
    },
  }),
];
