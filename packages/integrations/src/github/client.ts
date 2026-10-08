import { mapConcurrent, redacted, toMessage, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient } from "../shared/provider-client";
import { restPassthroughCapability } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import { getInstallationTokenForUser } from "./credentials";
import { GITHUB_API, githubHeaders } from "./rest";

/**
 * GitHub REST client: curated reads (ADR-0071) and the read-only passthrough (ADR-0074).
 * The token resolves on every request. `getInstallationToken`'s cache owns the 1h expiry,
 * so a held client never 401s. The token is unwrapped only in `githubHeaders`.
 */

export interface GithubTokenResolver {
  (): Promise<{ token: Redacted<string>; accountLogin: string | null }>;
}

export interface GithubClientOptions {
  resolveToken: GithubTokenResolver;
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

/** Cap so a huge issue body cannot flood the caller's context. */
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
  /** `null` for an issue or an unmerged PR. A multi-window search reads this to see why an item matched. */
  mergedAt: string | null;
}

export interface SearchResult {
  totalCount: number;
  incompleteResults: boolean;
  query: string;
  items: GithubSearchHit[];
}

const PULL_REQUEST_BATCH_CONCURRENCY = 5;

export interface PullRequestBatchFailure {
  owner: string;
  repo: string;
  number: number;
  error: string;
}

export interface PullRequestBatch {
  items: PullRequestDetail[];
  failed: PullRequestBatchFailure[];
  /** Sums `items` only; failed items are not counted. */
  totals: Pick<PullRequestDetail, "additions" | "deletions" | "changedFiles" | "commits">;
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
  /** Diff stats, which search does not return. */
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

/** `https://api.github.com/repos/owner/name` to `owner/name`. Each caller picks its own fallback. */
function repositoryFromUrl(repositoryUrl: string | undefined): string | undefined {
  if (repositoryUrl === undefined) return undefined;
  const marker = "/repos/";
  const idx = repositoryUrl.indexOf(marker);

  return idx >= 0 ? repositoryUrl.slice(idx + marker.length) : undefined;
}

/** Takes the resolver directly so tests can inject a token. Call sites use {@link githubClientForUser}. */
export function createGithubClient(options: GithubClientOptions) {
  const client = defineProviderClient({
    provider: "github",
    baseUrl: GITHUB_API,
    resolve: async () => ({ headers: githubHeaders((await options.resolveToken()).token) }),
    retry: options.retry,
    // The body ("Validation Failed", a rate-limit note) is what explains a failed call.
    bodyPolicy: "summarize",
  });

  const passthrough = restPassthroughCapability({
    slug: "github",
    retry: options.retry,
    resolveProfile: async () => ({
      baseUrl: GITHUB_API,
      headers: githubHeaders((await options.resolveToken()).token),
    }),
  });

  async function getPullRequest(args: {
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
  }

  return {
    /** For resolving `author:@me`. */
    async connectedLogin(): Promise<string | null> {
      return (await options.resolveToken()).accountLogin;
    },

    /** Read-only passthrough profile (ADR-0074). The read gate lives in `@alfred/assistant`. */
    passthrough,

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
        items: json.items.map((it) => {
          // `merged` derives from `merged_at` so the two cannot disagree.
          const mergedAt = it.pull_request?.merged_at ?? null;

          return {
            number: it.number,
            title: it.title,
            url: it.html_url,
            state: it.state,
            isPullRequest: it.pull_request !== undefined,
            merged: mergedAt !== null,
            repository: repositoryFromUrl(it.repository_url) ?? "",
            createdAt: it.created_at,
            closedAt: it.closed_at,
            mergedAt,
          };
        }),
      };
    },

    getPullRequest,

    /**
     * GitHub has no batch PR read, so fan out. Best effort: a 404 lands in `failed`
     * and the rest still return.
     */
    async getPullRequests(
      items: ReadonlyArray<{ owner: string; repo: string; number: number }>,
    ): Promise<PullRequestBatch> {
      const fetched: (PullRequestDetail | undefined)[] = Array.from({ length: items.length });
      const failed: PullRequestBatchFailure[] = [];
      await mapConcurrent(
        items.map((item, index) => ({ item, index })),
        PULL_REQUEST_BATCH_CONCURRENCY,
        async ({ item, index }) => {
          try {
            fetched[index] = await getPullRequest(item);
          } catch (err) {
            failed.push({ ...item, error: toMessage(err) });
          }
        },
      );
      // Keep the caller's order.
      const ok = fetched.filter((pr): pr is PullRequestDetail => pr !== undefined);

      return {
        items: ok,
        failed,
        totals: ok.reduce(
          (acc, pr) => ({
            additions: acc.additions + pr.additions,
            deletions: acc.deletions + pr.deletions,
            changedFiles: acc.changedFiles + pr.changedFiles,
            commits: acc.commits + pr.commits,
          }),
          { additions: 0, deletions: 0, changedFiles: 0, commits: 0 },
        ),
      };
    },

    /** Returns the body and comment count, which search omits. */
    async getIssue(args: { owner: string; repo: string; number: number }): Promise<IssueDetail> {
      const { owner, repo, number } = args;
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;

      const issue = issueSchema.parse(
        await client.json(path, { label: `repos/${owner}/${repo}/issues/${number}` }),
      );

      // Labels come as objects or bare strings.
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((label) => label.length > 0);

      return {
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        repository: repositoryFromUrl(issue.repository_url) ?? `${owner}/${repo}`,
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

export function githubClientForUser(options: ProviderBindOptions): GithubClient {
  const { userId, retry } = options;

  const resolveToken = async () => {
    const { token, accountLogin } = await getInstallationTokenForUser(userId, options.accountRef);

    return { token: redacted(token), accountLogin };
  };

  return createGithubClient({ resolveToken, retry });
}
