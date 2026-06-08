/**
 * GitHub tools registered into the boss's tool surface.
 *
 * Read-only over the GitHub App's installation (ADR-0052): search the user's
 * pull requests by author, state, and time window, scoped to the repos the
 * App is installed on. The boss uses `search_pull_requests` to answer
 * questions like "how many PRs did I close last week" directly, instead of
 * spawning a sub-agent (which it did when GitHub had no tools).
 */

import { searchPullRequestsInput } from "@alfred/contracts";
import { getInstallationTokenForUser, searchPullRequests } from "@alfred/integrations/github";
import type { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

type SearchPullRequestsInput = z.infer<typeof searchPullRequestsInput>;

interface GithubToolCredential {
  accessToken: string;
  accountLogin: string | null;
}

async function credentialFor(userId: string): Promise<GithubToolCredential> {
  // The REST search runs on a short-lived installation token; `accountLogin`
  // resolves `author:@me` to the connected handle.
  const { token, accountLogin } = await getInstallationTokenForUser(userId);
  return { accessToken: token, accountLogin };
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
  switch (input.state) {
    case "open":
      parts.push("is:open");
      break;
    case "closed":
      parts.push("is:closed");
      break;
    case "merged":
      parts.push("is:merged");
      break;
    case "all":
      break;
    default:
      assertNever(input.state);
  }
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

export function resolvePullRequestAuthor(
  author: string,
  accountLogin: string | null,
  userId = "unknown",
): string {
  if (author !== "@me") return author;
  if (!accountLogin) {
    throw new Error(
      `[github.tools] user ${userId} has no github login on the active credential — reconnect GitHub in settings`,
    );
  }
  return accountLogin;
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
      const credential = await credentialFor(ctx.userId);
      const author = resolvePullRequestAuthor(input.author, credential.accountLogin, ctx.userId);
      const q = buildPullRequestSearchQuery({ ...input, author });
      const result = await searchPullRequests({
        accessToken: credential.accessToken,
        q,
        perPage: input.perPage,
      });
      return {
        totalCount: result.totalCount,
        query: q,
        incompleteResults: result.incompleteResults,
        pullRequests: result.items,
      };
    },
  }),
];

function assertNever(value: never): never {
  throw new Error(`Unhandled pull-request state: ${String(value)}`);
}
