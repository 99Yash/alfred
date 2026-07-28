import { redacted, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient } from "../shared/provider-client";
import type { RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import { getInstallationTokenForUser } from "./credentials";
import { GITHUB_API, githubHeaders } from "./rest";

/**
 * The one door to GitHub's REST API — the curated read surface (ADR-0071) plus
 * the transport profile the general read-only passthrough tier (ADR-0074) sends
 * through. Nothing outside this file talks to `api.github.com` on a user's
 * behalf, which is what lets the security posture below be a property of the
 * code rather than a convention.
 *
 * The thesis lives in three properties:
 *
 *   1. The client holds a *credential resolver*, never a credential, and the
 *      resolve runs on EVERY request through the real path
 *      (`getInstallationTokenForUser` → `getInstallationToken`, whose in-process
 *      cache re-mints a few minutes before expiry). Nothing here memoizes on top
 *      of that: an installation token expires in an hour, so a memo with no
 *      expiry would save one indexed credential-row read per call and buy a
 *      client that 401s forever once it is held too long — where "too long" is a
 *      rule about the caller rather than a property of the code. Freshness lives
 *      in the one cache that knows the expiry.
 *   2. The resolved token is a {@link Redacted} and is unwrapped in exactly one
 *      place — `githubHeaders` in `./rest`, at the wire. It cannot reach a log or
 *      a thrown error by any default path, and no caller of this module ever
 *      holds a token at all.
 *   3. Base URL, headers, error classification and transient retry are baked in
 *      once, so a call site reads `github.search({ q })` — intent, not plumbing.
 */

/** Resolves a fresh installation token per call; the client stores this, not a token. */
export interface GithubTokenResolver {
  (): Promise<{ token: Redacted<string>; accountLogin: string | null }>;
}

export interface GithubClientOptions {
  resolveToken: GithubTokenResolver;
  /**
   * Transient-retry envelope for the read requests (all GETs, so retry-safe), or
   * `"none"`. Required — see `ProviderBindOptions.retry`.
   */
  retry: RetryPolicy | "none";
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
  /** Diff stats search cannot return (the #222 LOC need). */
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
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
 *
 * `resolveToken` is called once per request, here and through
 * {@link githubClientForUser} alike — there is no second entry point with
 * different freshness semantics, so a client is safe to hold for as long as its
 * resolver is.
 */
export function createGithubClient(options: GithubClientOptions) {
  const client = defineProviderClient({
    provider: "github",
    baseUrl: GITHUB_API,
    // Fresh installation token per request; unwrapped only here, at the headers.
    resolve: async () => ({ headers: githubHeaders((await options.resolveToken()).token) }),
    retry: options.retry,
    // GitHub's error bodies are prod-safe once bounded and secret-redacted, and
    // the message ("Validation Failed", a rate-limit note) is what makes a failed
    // tool call diagnosable. Stated, not inherited.
    bodyPolicy: "summarize",
  });

  return {
    /** The connected login (for resolving `author:@me`), resolved alongside the token. */
    async connectedLogin(): Promise<string | null> {
      return (await options.resolveToken()).accountLogin;
    },

    /**
     * Transport profile for the general read-only passthrough tier (ADR-0074):
     * the pinned REST authority + App-installation auth, as data.
     *
     * It lives here rather than beside the App code so the passthrough tool never
     * holds a token — it asks for a profile and hands it to the gate. The auth
     * header is built by the same `githubHeaders` unwrap the curated reads use, so
     * there is one place a GitHub credential becomes a header, not two.
     *
     * The gate that proves a request is a *read* is deliberately NOT here: it is
     * policy owned by `@alfred/api` (`assertReadableRestRequest`), and this
     * profile carries authority only.
     */
    async passthroughProfile(): Promise<RestPassthroughProfile> {
      return { baseUrl: GITHUB_API, headers: githubHeaders((await options.resolveToken()).token) };
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

    /** Fetch one issue by number — returns the body and comment count search omits. */
    async getIssue(args: { owner: string; repo: string; number: number }): Promise<IssueDetail> {
      const { owner, repo, number } = args;
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
      const issue = issueSchema.parse(
        await client.json(path, { label: `repos/${owner}/${repo}/issues/${number}` }),
      );
      // GitHub returns labels as objects, but older payloads (and some search
      // shapes) use bare strings — accept both and drop anything unnamed.
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((label) => label.length > 0);
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
        body: (issue.body ?? "").slice(0, MAX_ISSUE_BODY_CHARS),
      };
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

/**
 * The ergonomic call-site entry: a GitHub client for a user, reading as
 * `github.search({ q })` with no credential in sight.
 *
 * The resolver wraps the existing `getInstallationTokenForUser` mint/cache path
 * and hands back a {@link Redacted}. It is the whole difference from
 * {@link createGithubClient} — there is no bind-scoped memo layered on top, so
 * this client carries no lifetime rule for a caller to violate and holding one
 * past the request that made it cannot produce a stale token.
 */
export function githubClientForUser(options: ProviderBindOptions): GithubClient {
  const { userId, retry } = options;
  const resolveToken = async () => {
    const { token, accountLogin } = await getInstallationTokenForUser(userId);
    return { token: redacted(token), accountLogin };
  };
  return createGithubClient({ resolveToken, retry });
}
