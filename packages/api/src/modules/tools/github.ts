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
import { localDateInTimezone } from "../briefing/preferences";
import { addLocalDays, localTimeInTimezone } from "../timezone";
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

/**
 * Lower bound for a "within the last N days" filter, anchored on local midnight
 * in the user's timezone and serialized as a UTC-offset date-time for GitHub
 * search. N=1 resolves to *today* in that zone (not "24h ago in UTC"), so "PRs
 * I merged today" for an IST user includes the 00:00-05:29 IST slice that a
 * date-only GitHub qualifier would miss.
 */
function githubSearchDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function windowLowerBound(days: number, timezone: string, nowMs: number): string {
  const today = localDateInTimezone(timezone, new Date(nowMs));
  const lowerDate = addLocalDays(today, -(days - 1));
  return githubSearchDateTime(localTimeInTimezone(lowerDate, 0, timezone));
}

export function buildPullRequestSearchQuery(
  input: SearchPullRequestsInput,
  timezone: string,
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
    parts.push(`closed:>=${windowLowerBound(input.closedWithinDays, timezone, nowMs)}`);
  }
  if (input.createdWithinDays !== undefined) {
    parts.push(`created:>=${windowLowerBound(input.createdWithinDays, timezone, nowMs)}`);
  }
  if (input.mergedWithinDays !== undefined) {
    parts.push(`merged:>=${windowLowerBound(input.mergedWithinDays, timezone, nowMs)}`);
  }
  const extra = input.query?.trim();
  if (extra) parts.push(extra);
  // Defensive dedupe: the schema already rejects free-form clauses that collide
  // with the structured fields (#213), but if any identical token slips through
  // we never want it doubled in the emitted query.
  return [...new Set(parts.filter(Boolean))].join(" ");
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
      "Search the user's GitHub pull requests by author, state, and time window. Returns an exact total count plus the matching PRs. Always use the structured fields for author/state/recency — never hand-write those qualifiers into `query`. 'How many PRs did I merge today' → state:'merged', mergedWithinDays:1. 'closed this past week' → state:'closed', closedWithinDays:7. author defaults to @me.",
    inputSchema: searchPullRequestsInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId);
      const author = resolvePullRequestAuthor(input.author, credential.accountLogin, ctx.userId);
      const q = buildPullRequestSearchQuery({ ...input, author }, ctx.timezone);
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
