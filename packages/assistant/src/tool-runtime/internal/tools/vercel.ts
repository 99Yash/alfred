/** Vercel tools. The client adds the team scope, so these tools never pass it. */

import {
  restPassthroughInput,
  vercelListDeploymentsInput,
  vercelListProjectsInput,
  vercelRedeployInput,
} from "@alfred/contracts";
import { itemEvidence, type DeliveredItem } from "../../item-evidence";
import { runRestPassthrough } from "./passthrough";
import type { Integrations } from "@alfred/integrations";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";

type VercelClient = Integrations["vercel"];

/** The Vercel read results, named so the Code Mode index reads their types (ADR-0124). */
export interface VercelListProjectsResult {
  projects: Awaited<ReturnType<VercelClient["projects"]>>;
}

export interface VercelListDeploymentsResult {
  deployments: Awaited<ReturnType<VercelClient["deployments"]>>;
}

export const vercelTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "vercel",
    action: "list_projects",
    riskTier: "no_risk",
    replay: "safe",
    codeModeRead: true,
    // Its result is text from outside Alfred, so a URL in it is a fetch_url source (ADR-0130).
    outsideText: true,
    description:
      "List Vercel projects for the connected account/team, with framework and latest deployment state.",
    inputSchema: vercelListProjectsInput,
    execute: async (input, ctx): Promise<VercelListProjectsResult> => ({
      projects: await ctx.integrations.vercel.projects({ limit: input.limit }),
    }),
    readEvidence: (output) =>
      itemEvidence(output.projects.map((p) => vercelItem("project", p.id, p))),
  }),
  liveTool({
    integration: "vercel",
    action: "list_deployments",
    riskTier: "no_risk",
    replay: "safe",
    codeModeRead: true,
    // Its result is text from outside Alfred, so a URL in it is a fetch_url source (ADR-0130).
    outsideText: true,
    description:
      "List recent Vercel deployments, optionally scoped to a project, with state, target, and url. Use the returned uid as the deploymentId for redeploy.",
    inputSchema: vercelListDeploymentsInput,
    execute: async (input, ctx): Promise<VercelListDeploymentsResult> => ({
      deployments: await ctx.integrations.vercel.deployments({
        projectId: input.projectId,
        limit: input.limit,
      }),
    }),
    readEvidence: (output) =>
      itemEvidence(output.deployments.map((d) => vercelItem("deployment", d.uid, d))),
  }),
  liveTool({
    integration: "vercel",
    action: "redeploy",
    riskTier: "high",
    replay: "unsafe",
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
    replay: "safe",
    codeModeRead: true,
    // Its result is text from outside Alfred, so a URL in it is a fetch_url source (ADR-0130).
    outsideText: true,
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
    execute: async (input, ctx) => runRestPassthrough(ctx.integrations.vercel.passthrough, input),
  }),
];

/**
 * A Vercel object in the evidence record (ADR-0124). A list gives a summary. The client drops
 * Vercel's pagination, so a list states no coverage gap that it cannot see.
 */
function vercelItem(
  kind: "project" | "deployment",
  externalId: string,
  item: unknown,
): DeliveredItem {
  return {
    ref: { kind: "object", object: { provider: "vercel", kind, externalId }, depth: "hit" },
    item,
  };
}
