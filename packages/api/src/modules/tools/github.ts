/**
 * GitHub tools registered into the boss's tool surface.
 *
 * Read-only over the GitHub App's installation (ADR-0052): search the user's
 * issues and pull requests, and fetch one by number for the per-item detail
 * search structurally cannot return (ADR-0071). The boss uses `github.search`
 * to answer "how many PRs did I merge today" / "what issues are open" directly,
 * and `github.get_pull_request` to total LOC across a set of PRs (#222).
 */

import {
  githubGetIssueInput,
  githubGetPullRequestInput,
  githubSearchInput,
  queryHasNarrowingScope,
  sanitizeGithubSearchQuery,
} from "@alfred/contracts";
import {
  getInstallationTokenForUser,
  getIssue,
  getPullRequest,
  searchGithub,
} from "@alfred/integrations/github";
import type { z } from "zod";
import { localDateInTimezone } from "../briefing/preferences";
import { addLocalDays, localTimeInTimezone } from "../timezone";
import { liveTool, type RegisteredTool } from "./registry";
import { AppError } from "../../lib/app-errors";

type GithubSearchInput = z.infer<typeof githubSearchInput>;

interface GithubToolCredential {
  accessToken: string;
  accountLogin: string | null;
}

async function credentialFor(userId: string): Promise<GithubToolCredential> {
  // The REST calls run on a short-lived installation token; `accountLogin`
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

/**
 * Build the fully-formed `/search/issues` query from the (already sanitized)
 * structured fields plus any clean free-form qualifiers. The `type` field owns
 * the `is:pr`/`is:issue` clause. A trailing `new Set` dedupe guarantees no
 * doubled token even if a clean extra qualifier coincides with a structured one.
 */
export function buildGithubSearchQuery(
  input: GithubSearchInput,
  timezone: string,
  nowMs = Date.now(),
): string {
  const parts: string[] = [];
  const type = input.type ?? "pr";
  switch (type) {
    case "pr":
      parts.push("is:pr");
      break;
    case "issue":
      parts.push("is:issue");
      break;
    case "both":
      break;
    default:
      assertNever(type);
  }
  if (input.author) parts.push(`author:${input.author}`);
  const state = input.state ?? "all";
  switch (state) {
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
      assertNever(state);
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
  return [...new Set(parts.filter(Boolean))].join(" ");
}

export function resolvePullRequestAuthor(
  author: string,
  accountLogin: string | null,
  _userId = "unknown",
): string {
  if (author !== "@me") return author;
  if (!accountLogin) {
    throw new AppError("github_connection_required");
  }
  return accountLogin;
}

export const githubTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "github",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search the user's GitHub issues and pull requests by author, state, type, and time window. Returns an exact total count plus the matching items. Use the structured fields for type/author/state/recency — anything you put in `query` (author:, is:, state:) is folded into them automatically. 'How many PRs did I merge today' → type:'pr', state:'merged', mergedWithinDays:1. 'My open issues' → type:'issue', state:'open'. type defaults to pr; author defaults to @me ONLY for an unscoped search — a repo:/org:-scoped search is NOT narrowed to your items unless you set author:'@me'.",
    inputSchema: githubSearchInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId);
      // Fold any free-typed author:/state:/is:/date qualifiers into the
      // structured fields (silent correctness, ADR-0071) before resolving @me.
      const { sanitized } = sanitizeGithubSearchQuery(input);
      // Resolve author honestly (ADR-0071, no silent narrowing): an explicit
      // author (structured field or folded `author:` qualifier) wins; otherwise
      // default to the connected user ONLY for an otherwise-unscoped search ("my
      // PRs"). A query that already names a repo/org/person is left
      // author-unfiltered — forcing `@me` there would silently narrow it.
      const author = sanitized.author
        ? resolvePullRequestAuthor(sanitized.author, credential.accountLogin, ctx.userId)
        : queryHasNarrowingScope(sanitized.query)
          ? undefined
          : resolvePullRequestAuthor("@me", credential.accountLogin, ctx.userId);
      const q = buildGithubSearchQuery({ ...input, ...sanitized, author }, ctx.timezone);
      const result = await searchGithub({
        accessToken: credential.accessToken,
        q,
        perPage: input.perPage,
      });
      // Result-honesty (ADR-0071 #6): never present a truncated count as exact.
      const note = result.incompleteResults
        ? "GitHub reported incomplete_results — its search index timed out, so this count may be partial. Narrow the query (repo:, a tighter window) and retry for an exact figure."
        : undefined;
      return {
        totalCount: result.totalCount,
        query: q,
        incompleteResults: result.incompleteResults,
        items: result.items,
        ...(note ? { note } : {}),
      };
    },
  }),
  liveTool({
    integration: "github",
    action: "get_pull_request",
    // Read-only fetch-by-number — same tier as github.search and drive.get_file.
    riskTier: "no_risk",
    description:
      "Fetch one pull request by owner/repo/number. Returns diff stats — additions, deletions, changed_files, commits — that search cannot. To total lines changed across several PRs, search first, then call this for each hit and sum.",
    inputSchema: githubGetPullRequestInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId);
      return getPullRequest({
        accessToken: credential.accessToken,
        owner: input.owner,
        repo: input.repo,
        number: input.pull_number,
      });
    },
  }),
  liveTool({
    integration: "github",
    action: "get_issue",
    // Read-only fetch-by-number — same tier as github.search and drive.get_file.
    riskTier: "no_risk",
    description:
      "Fetch one issue by owner/repo/number. Returns the issue body, labels, and comment count (search returns only the title and metadata).",
    inputSchema: githubGetIssueInput,
    execute: async (input, ctx) => {
      const credential = await credentialFor(ctx.userId);
      return getIssue({
        accessToken: credential.accessToken,
        owner: input.owner,
        repo: input.repo,
        number: input.issue_number,
      });
    },
  }),
];

function assertNever(value: never): never {
  throw new Error(`Unhandled github search enum: ${String(value)}`);
}
