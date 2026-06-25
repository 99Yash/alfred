import { httpErrorFromResponse } from "@alfred/contracts";
import { z } from "zod";

/**
 * GitHub issue/PR reads via the REST API. Read-only; uses the user's stored
 * installation token. Mirrors the thin-fetch style of the Google Drive helper
 * — no Octokit dependency, just `fetch` with the documented headers (GitHub
 * rejects requests without a `User-Agent`).
 *
 * Two shapes (ADR-0071): {@link searchGithub} over `/search/issues` answers
 * "which issues/PRs match" (an exact count + a list), and the fetch-by-number
 * {@link getPullRequest} / {@link getIssue} return the per-item detail search
 * structurally cannot — a PR's `additions`/`deletions`/`changed_files` (the
 * #222 LOC need) and an issue's body/comment count.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "alfred-app";

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

export interface SearchGithubArgs {
  accessToken: string;
  /** A fully-formed GitHub issues-search query (already scoped with is:pr / is:issue). */
  q: string;
  perPage?: number;
  sort?: "created" | "updated" | "comments";
  order?: "asc" | "desc";
}

export interface GithubSearchHit {
  number: number;
  title: string;
  url: string;
  /** GitHub search reports `open` | `closed`; `merged` is derived below. */
  state: string;
  /** True for a pull request, false for an issue (`/search/issues` returns both). */
  isPullRequest: boolean;
  merged: boolean;
  repository: string;
  createdAt: string;
  closedAt: string | null;
}

export interface SearchGithubResult {
  totalCount: number;
  incompleteResults: boolean;
  /** Echo of the resolved query so callers can show/verify what ran. */
  query: string;
  items: GithubSearchHit[];
}

// Back-compat aliases (the surface was PR-only before ADR-0071).
export type SearchPullRequestsArgs = SearchGithubArgs;
export type SearchPullRequestsResult = SearchGithubResult;
export type PullRequestHit = GithubSearchHit;

/** `https://api.github.com/repos/owner/name` → `owner/name`. */
function repositoryFromUrl(repositoryUrl: unknown): string {
  if (typeof repositoryUrl !== "string") return "";
  const marker = "/repos/";
  const idx = repositoryUrl.indexOf(marker);
  return idx >= 0 ? repositoryUrl.slice(idx + marker.length) : "";
}

const searchIssuesResponseSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      state: z.string(),
      created_at: z.string(),
      closed_at: z.string().nullable(),
      repository_url: z.string(),
      pull_request: z
        .object({
          merged_at: z.string().nullable().optional(),
        })
        .optional(),
    }),
  ),
});

export async function searchGithub(args: SearchGithubArgs): Promise<SearchGithubResult> {
  const url = new URL(`${GITHUB_API}/search/issues`);
  url.searchParams.set("q", args.q);
  // Advanced search has been the default for /search/issues since 2025-09-04
  // (the legacy mode was removed then), so this is no longer strictly required.
  // We set it explicitly anyway: the query builder joins qualifiers with spaces
  // expecting AND semantics, which is exactly advanced search's space operator
  // — pinning the flag documents that dependency and is future-proof.
  // https://github.blog/changelog/2025-03-06-github-issues-projects-api-support-for-issues-advanced-search-and-more/
  url.searchParams.set("advanced_search", "true");
  url.searchParams.set("per_page", String(Math.min(Math.max(args.perPage ?? 30, 1), 100)));
  if (args.sort) url.searchParams.set("sort", args.sort);
  if (args.order) url.searchParams.set("order", args.order);

  const res = await fetch(url, {
    headers: githubHeaders(args.accessToken),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("github", res, { url: "search/issues" });
  }
  const json = searchIssuesResponseSchema.parse(await res.json());
  const items: GithubSearchHit[] = (json.items ?? []).map((it) => ({
    number: it.number,
    title: it.title,
    url: it.html_url,
    state: it.state,
    isPullRequest: it.pull_request !== undefined,
    merged: Boolean(it.pull_request?.merged_at),
    repository: repositoryFromUrl(it.repository_url),
    createdAt: it.created_at,
    closedAt: it.closed_at ?? null,
  }));
  return {
    totalCount: json.total_count ?? 0,
    incompleteResults: Boolean(json.incomplete_results),
    query: args.q,
    items,
  };
}

export interface GetByNumberArgs {
  accessToken: string;
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  draft: boolean;
  repository: string;
  author: string | null;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  /** Diff stats search cannot return (the #222 LOC need). */
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
}

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  created_at: z.string(),
  closed_at: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  commits: z.number().optional(),
  base: z.object({ repo: z.object({ full_name: z.string() }).optional() }).optional(),
});

/**
 * Fetch one PR by number — returns the diff stats (`additions`/`deletions`/
 * `changed_files`) that `/search/issues` cannot. The boss fans out over search
 * hits to total LOC across a set of PRs.
 */
export async function getPullRequest(args: GetByNumberArgs): Promise<PullRequestDetail> {
  const { owner, repo, number } = args;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const res = await fetch(url, {
    headers: githubHeaders(args.accessToken),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("github", res, {
      url: `repos/${owner}/${repo}/pulls/${number}`,
    });
  }
  const pr = pullRequestSchema.parse(await res.json());
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    merged: Boolean(pr.merged ?? pr.merged_at),
    draft: Boolean(pr.draft),
    repository: pr.base?.repo?.full_name ?? `${owner}/${repo}`,
    author: pr.user?.login ?? null,
    createdAt: pr.created_at,
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    commits: pr.commits ?? 0,
  };
}

export interface IssueDetail {
  number: number;
  title: string;
  url: string;
  state: string;
  repository: string;
  author: string | null;
  labels: string[];
  comments: number;
  createdAt: string;
  closedAt: string | null;
  body: string;
}

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  created_at: z.string(),
  closed_at: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  comments: z.number().optional(),
  body: z.string().nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])).optional(),
  repository_url: z.string().optional(),
});

/** Hard cap on an inlined issue body so a huge issue can't blow up the caller's context. */
const MAX_ISSUE_BODY_CHARS = 20_000;

/** Fetch one issue by number — returns the body and comment count search omits. */
export async function getIssue(args: GetByNumberArgs): Promise<IssueDetail> {
  const { owner, repo, number } = args;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  const res = await fetch(url, {
    headers: githubHeaders(args.accessToken),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("github", res, {
      url: `repos/${owner}/${repo}/issues/${number}`,
    });
  }
  const issue = issueSchema.parse(await res.json());
  const labels = (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((l) => l.length > 0);
  const body = (issue.body ?? "").slice(0, MAX_ISSUE_BODY_CHARS);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    repository: repositoryFromUrl(issue.repository_url) || `${owner}/${repo}`,
    author: issue.user?.login ?? null,
    labels,
    comments: issue.comments ?? 0,
    createdAt: issue.created_at,
    closedAt: issue.closed_at ?? null,
    body,
  };
}
