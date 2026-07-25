/**
 * Vercel tools (read + write). Reads list projects and deployments; `redeploy`
 * re-deploys an existing deployment (tier `high`).
 *
 * Every call goes through `ctx.integrations.vercel`, so this file names no
 * credential function and holds no token. The team scope a team install must echo
 * on every call is the client's business, not a field these tools thread through.
 */

import {
  restPassthroughInput,
  vercelListDeploymentsInput,
  vercelListProjectsInput,
  vercelRedeployInput,
} from "@alfred/contracts";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "./registry";

export const vercelTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "vercel",
    action: "list_projects",
    riskTier: "no_risk",
    description:
      "List Vercel projects for the connected account/team, with framework and latest deployment state.",
    inputSchema: vercelListProjectsInput,
    execute: async (input, ctx) => ({
      projects: await ctx.integrations.vercel.projects({ limit: input.limit }),
    }),
  }),
  liveTool({
    integration: "vercel",
    action: "list_deployments",
    riskTier: "no_risk",
    description:
      "List recent Vercel deployments, optionally scoped to a project, with state, target, and url. Use the returned uid as the deploymentId for redeploy.",
    inputSchema: vercelListDeploymentsInput,
    execute: async (input, ctx) => ({
      deployments: await ctx.integrations.vercel.deployments({
        projectId: input.projectId,
        limit: input.limit,
      }),
    }),
  }),
  liveTool({
    integration: "vercel",
    action: "redeploy",
    riskTier: "high",
    description:
      "Redeploy an existing Vercel deployment. Pass the deployment uid and the project name; target defaults to the original deployment's target.",
    inputSchema: vercelRedeployInput,
    execute: async (input, ctx) =>
      ctx.integrations.vercel.redeploy({
        deploymentId: input.deploymentId,
        name: input.name,
        target: input.target,
      }),
  }),
  liveTool({
    integration: "vercel",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Vercel REST call for anything the curated vercel tools don't cover — a project's details (GET '/v9/projects/{idOrName}'), a deployment's detail or build events (GET '/v13/deployments/{id}'), domains, environment variable metadata, or aliases. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (include the API version segment, e.g. '/v6/deployments'; never a full URL), and `query` for parameters (limit, projectId). `teamId` is applied automatically for team installs — do not add it. This is a raw, unvalidated read: a 404 or empty result may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["vercel api", "vercel request", "call vercel"],
      tags: ["vercel", "deployment", "hosting"],
      entities: ["project", "deployment", "domain", "alias", "environment variable"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["vercel.list_projects", "vercel.list_deployments"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) =>
      runRestPassthrough("vercel", await ctx.integrations.vercel.passthroughProfile(), input),
  }),
];
