/** Read-only GitHub tools over the App installation (ADR-0052). */

import {
  GITHUB_SEARCH_WINDOWS,
  githubGetIssueInput,
  githubGetPullRequestInput,
  githubGetPullRequestsInput,
  githubSearchInput,
  githubSearchWindowDays,
  queryHasNarrowingScope,
  restPassthroughInput,
  sanitizeGithubSearchQuery,
} from "@alfred/contracts";
import type { IanaTimezone } from "@alfred/contracts";
import type { z } from "zod";
import { addDays, inZone } from "@alfred/assistant/time";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { AppError } from "@alfred/contracts/app-errors";

type GithubSearchInput = z.infer<typeof githubSearchInput>;

function githubSearchDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * Local midnight N-1 days ago, as a date-time. A date-only qualifier would miss
 * the start of an IST user's day, which falls on the previous UTC date.
 */
function windowLowerBound(days: number, timezone: IanaTimezone, nowMs: number): string {
  const zone = inZone(timezone);
  const lowerDate = addDays(zone.day(new Date(nowMs)), -(days - 1));

  return githubSearchDateTime(zone.startOf(lowerDate));
}

/** Build the `/search/issues` query from sanitized fields. The final `Set` drops doubled tokens. */
export function buildGithubSearchQuery(
  input: GithubSearchInput,
  timezone: IanaTimezone,
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

  // Several windows form one OR group. GitHub ANDs top-level tokens, so
  // `created:>=D merged:>=D` silently drops a PR created in the window but merged later.
  // The schema refuses free-form date windows in `query` for the same reason.
  const windows = GITHUB_SEARCH_WINDOWS.flatMap((entry) => {
    const days = githubSearchWindowDays(input, entry);

    if (days === undefined) return [];

    return [`${entry.qualifier}:>=${windowLowerBound(days, timezone, nowMs)}`];
  });

  // The client's `advanced_search=true` makes `(… OR …)` a boolean group.
  if (windows.length > 1) parts.push(`(${windows.join(" OR ")})`);
  else parts.push(...windows);
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
    throw new AppError("reauth_required", { integration: "github" });
  }

  return accountLogin;
}

export const githubTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "github",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search the user's GitHub issues and pull requests by author, state, type, and time window. Returns an exact total count plus the matching items. Use the structured fields for type/author/state/recency — anything you put in `query` (author:, is:, state:) is folded into them automatically. 'How many PRs did I merge today' → type:'pr', state:'merged', mergedWithinDays:1. 'My open issues' → type:'issue', state:'open'. 'What did I ship this week' → state:'all', activeWithinDays:7 — one search, never one per state. Each item carries createdAt, mergedAt, closedAt, state and merged, so read those to say which event happened when. type defaults to pr; author defaults to @me ONLY for an unscoped search — a repo:/org:-scoped search is NOT narrowed to your items unless you set author:'@me'. For diff stats on the hits, pass them all to github.get_pull_requests in one call.",
    discovery: {
      aliases: ["search GitHub", "find pull requests", "find issues"],
      tags: ["github", "code", "development"],
      entities: ["pull request", "pr", "issue", "repository"],
      verbs: ["search", "find", "list", "count"],
      relatedTools: ["github.get_pull_requests", "github.get_pull_request", "github.get_issue"],
    },
    inputSchema: githubSearchInput,
    execute: async (input, ctx) => {
      const github = ctx.integrations.github;
      // `author:@me` resolves against the connected handle.
      const accountLogin = await github.connectedLogin();
      // Fold free-typed qualifiers into the structured fields (ADR-0071).
      const { sanitized } = sanitizeGithubSearchQuery(input);

      // Default to `@me` only for an unscoped search. Forcing it on a repo query would narrow it.
      const author = sanitized.author
        ? resolvePullRequestAuthor(sanitized.author, accountLogin, ctx.userId)
        : queryHasNarrowingScope(sanitized.query)
          ? undefined
          : resolvePullRequestAuthor("@me", accountLogin, ctx.userId);

      const q = buildGithubSearchQuery(
        { ...input, ...sanitized, state: sanitized.state ?? input.state, author },
        ctx.timezone,
      );

      const result = await github.search({ q, perPage: input.perPage });

      // Never present a truncated count as exact (ADR-0071).
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
    riskTier: "no_risk",
    description:
      "Fetch ONE pull request by owner/repo/number. Returns diff stats — additions, deletions, changed_files, commits — that search cannot. For two or more PRs (every hit of a search, a set to total) use github.get_pull_requests once instead of calling this per PR.",
    discovery: {
      aliases: ["get pull request", "read PR", "pull request details"],
      tags: ["github", "code", "development"],
      entities: ["pull request", "pr", "diff"],
      verbs: ["get", "read", "inspect"],
      relatedTools: ["github.search", "github.get_pull_requests"],
    },
    inputSchema: githubGetPullRequestInput,
    execute: async (input, ctx) =>
      ctx.integrations.github.getPullRequest({
        owner: input.owner,
        repo: input.repo,
        number: input.pull_number,
      }),
  }),
  liveTool({
    integration: "github",
    action: "get_pull_requests",
    riskTier: "no_risk",
    description:
      "Fetch SEVERAL pull requests in one call — pass every owner/repo/pull_number (or each hit's url) from a search as `items`. Returns each PR's diff stats (additions, deletions, changed_files, commits) plus `totals` summed for you, and lists any item that could not be fetched under `failed`. This is the way to total lines changed across a set of PRs or to summarize recent PR work: one search, then one call here — never one github.get_pull_request per hit.",
    discovery: {
      aliases: ["get pull requests", "read PRs", "pull request stats", "total lines changed"],
      tags: ["github", "code", "development"],
      entities: ["pull request", "pr", "diff"],
      verbs: ["get", "read", "inspect", "total", "sum"],
      relatedTools: ["github.search", "github.get_pull_request"],
    },
    inputSchema: githubGetPullRequestsInput,
    execute: async (input, ctx) =>
      ctx.integrations.github.getPullRequests(
        input.items.map((item) => ({
          owner: item.owner,
          repo: item.repo,
          number: item.pull_number,
        })),
      ),
  }),
  liveTool({
    integration: "github",
    action: "get_issue",
    riskTier: "no_risk",
    description:
      "Fetch one issue by owner/repo/number. Returns the issue body, labels, and comment count (search returns only the title and metadata).",
    discovery: {
      aliases: ["get issue", "read GitHub issue", "issue details"],
      tags: ["github", "code", "development"],
      entities: ["issue", "ticket"],
      verbs: ["get", "read", "inspect"],
      relatedTools: ["github.search"],
    },
    inputSchema: githubGetIssueInput,
    execute: async (input, ctx) =>
      ctx.integrations.github.getIssue({
        owner: input.owner,
        repo: input.repo,
        number: input.issue_number,
      }),
  }),
  liveTool({
    integration: "github",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY GitHub REST call for anything the curated github tools don't cover — repo-scoped reads such as workflow runs, commits, releases, branches, tags, contents, issues/pulls detail (e.g. GET '/repos/{owner}/{repo}/actions/runs', '/repos/{owner}/{repo}/commits', '/repos/{owner}/{repo}/releases'). Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (never a full URL), and `query` for parameters (per_page, page, sha, branch, since). GitHub's list endpoints paginate — set per_page/page rather than assuming the first page is everything. Note '/notifications' is user-scoped and NOT reachable under the App installation token; the curated github.search covers issues/PRs across repos. This is a raw, unvalidated read: a 404 or empty array may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["github api", "github rest", "call github", "github request"],
      tags: ["github", "code", "development"],
      entities: ["workflow run", "commit", "release", "branch", "repository", "tag"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["github.search", "github.get_pull_requests"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => runRestPassthrough(ctx.integrations.github.passthrough, input),
  }),
];

function assertNever(value: never): never {
  throw new Error(`Unhandled github search enum: ${String(value)}`);
}
