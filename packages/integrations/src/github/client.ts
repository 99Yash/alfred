import { redacted, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient } from "../shared/provider-client";
import type { RetryPolicy } from "../shared/retry";
import { getInstallationTokenForUser } from "./credentials";

/**
 * PROTOTYPE — the "reads like code" provider-client shape, demonstrated on
 * GitHub. It exists to let us *feel* the call sites and the security posture
 * before deciding whether to sweep every vendor onto it; the existing
 * `pull-requests.ts` helpers are untouched.
 *
 * The whole thesis lives in three properties:
 *
 *   1. The client holds a *token resolver*, never a token. Each method resolves
 *      a FRESH short-lived installation token per call through the real
 *      cache/mint path (`getInstallationTokenForUser`) — nothing stale is ever
 *      cached on the object, and no secret sits in a field waiting to leak.
 *   2. The resolved token is a {@link Redacted} and is unwrapped in exactly one
 *      place: {@link githubHeaders}, at the wire. It cannot reach a log or a
 *      thrown error by any default path.
 *   3. Base URL, headers, error classification and transient retry are baked in
 *      once, so a call site reads `github.searchIssues({ q })` — intent, not
 *      plumbing.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "alfred-app";

/** The single place the secret is unwrapped — at the moment it becomes a header. */
function githubHeaders(token: Redacted<string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token.unwrap()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

/** Resolves a fresh installation token per call; the client stores this, not a token. */
export interface GithubTokenResolver {
  (): Promise<{ token: Redacted<string>; accountLogin: string | null }>;
}

export interface GithubClientOptions {
  resolveToken: GithubTokenResolver;
  /** Transient-retry envelope for the read requests (all GETs, so retry-safe). */
  retry?: RetryPolicy;
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
      pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
    }),
  ),
});

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

export interface GithubSearchHit {
  number: number;
  title: string;
  url: string;
  state: string;
  isPullRequest: boolean;
  merged: boolean;
  repository: string;
  createdAt: string;
  closedAt: string | null;
}

export interface SearchResult {
  totalCount: number;
  incompleteResults: boolean;
  query: string;
  items: GithubSearchHit[];
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
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
}

/** `https://api.github.com/repos/owner/name` → `owner/name`. */
function repositoryFromUrl(repositoryUrl: unknown): string {
  if (typeof repositoryUrl !== "string") return "";
  const marker = "/repos/";
  const idx = repositoryUrl.indexOf(marker);
  return idx >= 0 ? repositoryUrl.slice(idx + marker.length) : "";
}

/**
 * A GitHub REST client bound to a token *resolver*. Prefer
 * {@link githubClientForUser} at call sites; this constructor takes the resolver
 * directly so tests can inject a fixed token without touching credentials.
 */
export function createGithubClient(options: GithubClientOptions) {
  const client = defineProviderClient({
    provider: "github",
    baseUrl: GITHUB_API,
    // Fresh installation token per request; unwrapped only here, at the headers.
    resolve: async () => ({ headers: githubHeaders((await options.resolveToken()).token) }),
    retry: options.retry,
  });

  return {
    /** The connected login (for resolving `author:@me`), resolved alongside the token. */
    async connectedLogin(): Promise<string | null> {
      return (await options.resolveToken()).accountLogin;
    },

    async search(args: {
      q: string;
      perPage?: number;
      sort?: "created" | "updated" | "comments";
      order?: "asc" | "desc";
    }): Promise<SearchResult> {
      const json = searchIssuesResponseSchema.parse(
        await client.json("/search/issues", {
          label: "search/issues",
          query: {
            q: args.q,
            advanced_search: "true",
            per_page: Math.min(Math.max(args.perPage ?? 30, 1), 100),
            sort: args.sort,
            order: args.order,
          },
        }),
      );
      return {
        totalCount: json.total_count,
        incompleteResults: json.incomplete_results,
        query: args.q,
        items: json.items.map((it) => ({
          number: it.number,
          title: it.title,
          url: it.html_url,
          state: it.state,
          isPullRequest: it.pull_request !== undefined,
          merged: Boolean(it.pull_request?.merged_at),
          repository: repositoryFromUrl(it.repository_url),
          createdAt: it.created_at,
          closedAt: it.closed_at,
        })),
      };
    },

    async getPullRequest(args: {
      owner: string;
      repo: string;
      number: number;
    }): Promise<PullRequestDetail> {
      const { owner, repo, number } = args;
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
      const pr = pullRequestSchema.parse(
        await client.json(path, { label: `repos/${owner}/${repo}/pulls/${number}` }),
      );
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
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

/**
 * The ergonomic call-site entry: a GitHub client for a user. The token resolver
 * wraps the existing `getInstallationTokenForUser` mint/cache path and hands
 * back a {@link Redacted} — so the resulting client reads as
 * `githubClientForUser(userId).searchIssues({ q })` and never exposes a token.
 */
export function githubClientForUser(options: ProviderBindOptions): GithubClient {
  const { userId, retry } = options;
  return createGithubClient({
    resolveToken: async () => {
      const { token, accountLogin } = await getInstallationTokenForUser(userId);
      return { token: redacted(token), accountLogin };
    },
    retry,
  });
}
