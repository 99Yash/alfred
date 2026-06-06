/**
 * GitHub tools registered into the boss's tool surface.
 *
 * Read-only at the current grant (`repo`, `read:user`): search the user's
 * pull requests by author, state, and time window. Mirrors drive.ts for
 * credential resolution. The boss uses `search_pull_requests` to answer
 * questions like "how many PRs did I close last week" directly, instead of
 * spawning a sub-agent (which it did when GitHub had no tools).
 */

import {
  getGithubAccessToken,
  listGithubCredentials,
  searchPullRequests,
} from "@alfred/integrations/github";
import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const searchPullRequestsInput = z
  .object({
    author: z
      .string()
      .min(1)
      .max(100)
      .default("@me")
      .describe("PR author login, or `@me` (default) for the connected user."),
    state: z
      .enum(["open", "closed", "merged", "all"])
      .default("all")
      .describe("PR state filter. `closed` includes merged PRs; `merged` is merged-only."),
    closedWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only PRs closed within the last N days (e.g. 7 for the past week)."),
    createdWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only PRs created within the last N days."),
    query: z
      .string()
      .max(256)
      .optional()
      .describe('Extra GitHub search qualifiers appended verbatim, e.g. "repo:owner/name label:bug".'),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe("Max PRs to return in the list (the total count is always exact)."),
  })
  .strict();

type SearchPullRequestsInput = z.infer<typeof searchPullRequestsInput>;

async function accessTokenFor(userId: string): Promise<string> {
  const creds = await listGithubCredentials(userId);
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[github.tools] user ${userId} has no active github credential — connect GitHub in settings`,
    );
  }
  return getGithubAccessToken(active.id);
}

/** ISO date (YYYY-MM-DD) N days before now — for `closed:>=`/`created:>=` filters. */
function daysAgoIsoDate(days: number, nowMs: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

export function buildPullRequestSearchQuery(
  input: SearchPullRequestsInput,
  nowMs = Date.now(),
): string {
  const parts: string[] = ["is:pr"];
  parts.push(`author:${input.author}`);
  if (input.state === "open") parts.push("is:open");
  else if (input.state === "closed") parts.push("is:closed");
  else if (input.state === "merged") parts.push("is:merged");
  if (input.closedWithinDays !== undefined) {
    parts.push(`closed:>=${daysAgoIsoDate(input.closedWithinDays, nowMs)}`);
  }
  if (input.createdWithinDays !== undefined) {
    parts.push(`created:>=${daysAgoIsoDate(input.createdWithinDays, nowMs)}`);
  }
  const extra = input.query?.trim();
  if (extra) parts.push(extra);
  return parts.join(" ");
}

export const githubTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "github",
    action: "search_pull_requests",
    riskTier: "no_risk",
    description:
      "Search the user's GitHub pull requests by author, state, and time window. Returns an exact total count plus the matching PRs. For 'how many PRs did I close in the past week', use state:'closed', closedWithinDays:7 (author defaults to @me).",
    inputSchema: searchPullRequestsInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      const q = buildPullRequestSearchQuery(input);
      const result = await searchPullRequests({ accessToken, q, perPage: input.perPage });
      return {
        totalCount: result.totalCount,
        query: q,
        incompleteResults: result.incompleteResults,
        pullRequests: result.items,
      };
    },
  }),
];
