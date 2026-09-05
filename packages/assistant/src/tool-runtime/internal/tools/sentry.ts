/**
 * Sentry tools. The only tool today is the general read-only passthrough: the
 * curated reads (an issue, its latest event with source context) arrive with
 * the consumer that needs them (the Seer pull-request verifier, #567).
 *
 * Every call goes through `ctx.integrations.sentry`, so this file names no
 * credential function and holds no token.
 */

import { restPassthroughInput } from "@alfred/contracts";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";

export const sentryTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "sentry",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Sentry REST call — an organization's projects (GET '/organizations/{org}/projects/'), its issues (GET '/organizations/{org}/issues/'), one issue (GET '/organizations/{org}/issues/{issue_id}/'), or an issue's latest event with stack trace and source context (GET '/organizations/{org}/issues/{issue_id}/events/latest/'). Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (the '/api/0' prefix is applied for you; never a full URL), and `query` for parameters (query, statsPeriod, cursor). Paths end with a trailing slash. This is a raw, unvalidated read: a 404 or empty result may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["sentry api", "sentry request", "call sentry"],
      tags: ["sentry", "errors", "monitoring"],
      entities: ["issue", "event", "project", "release", "stack trace"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: [],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => runRestPassthrough(ctx.integrations.sentry.passthrough, input),
  }),
];
