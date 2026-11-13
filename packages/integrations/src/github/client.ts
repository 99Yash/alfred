import { mapConcurrent, redacted, toMessage, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient } from "../shared/provider-client";
import type { RetryPolicy } from "../shared/retry";
import { getInstallationTokenForUser } from "./credentials";
import { GITHUB_API, githubHeaders } from "./rest";

/**
 * GitHub REST client for the loop verifier's pull request read (ADR-0120). The model has no
 * GitHub REST tool: it reads GitHub through the GitHub MCP built-in (ADR-0125).
 * The token resolves on every request. `getInstallationToken`'s cache owns the 1h expiry,
 * so a held client never 401s. The token is unwrapped only in `githubHeaders`.
 */

export interface GithubTokenResolver {
  (): Promise<{ token: Redacted<string> }>;
}

export interface GithubClientOptions {
  resolveToken: GithubTokenResolver;
  retry: RetryPolicy | "none";
}

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
});

const BATCH_READ_CONCURRENCY = 5;

interface BatchReadItem {
  owner: string;
  repo: string;
  number: number;
}

export interface BatchReadFailure extends BatchReadItem {
  error: string;
}

export interface PullRequestBatch {
  items: PullRequestDetail[];
  failed: BatchReadFailure[];
}

/**
 * GitHub has no batch read for pull requests, so fan out. Best effort: a 404 lands in `failed`
 * and the rest still return, in the caller's order. After `signal` aborts, each read that is left
 * fails fast into `failed`, so the reads that completed still return.
 */
async function readEach<T>(
  items: ReadonlyArray<BatchReadItem>,
  readOne: (item: BatchReadItem) => Promise<T>,
): Promise<{ items: T[]; failed: BatchReadFailure[] }> {
  const fetched: (T | undefined)[] = Array.from({ length: items.length });
  const failed: BatchReadFailure[] = [];
  await mapConcurrent(
    items.map((item, index) => ({ item, index })),
    BATCH_READ_CONCURRENCY,
    async ({ item, index }) => {
      try {
        fetched[index] = await readOne(item);
      } catch (err) {
        failed.push({ ...item, error: toMessage(err) });
      }
    },
  );

  return { items: fetched.filter((value): value is T => value !== undefined), failed };
}

/** The pull request facts that the loop verifier folds. */
export interface PullRequestDetail {
  /** GitHub's numeric id. The webhook keys the `integration_objects` row by it. */
  githubId: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  closedAt: string | null;
  mergedAt: string | null;
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

  async function getPullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    signal?: AbortSignal | undefined;
  }): Promise<PullRequestDetail> {
    const { owner, repo, number } = args;
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;

    const pr = await client.json(pullRequestSchema, path, {
      label: `repos/${owner}/${repo}/pulls/${number}`,
      signal: args.signal,
    });

    return {
      githubId: pr.id,
      title: pr.title,
      url: pr.html_url,
      state: pr.state,
      merged: Boolean(pr.merged ?? pr.merged_at),
      closedAt: pr.closed_at ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  }

  return {
    /** Reads each pull request concurrently. See {@link readEach} for the failure contract. */
    async getPullRequests(
      items: ReadonlyArray<BatchReadItem>,
      options: { signal?: AbortSignal | undefined } = {},
    ): Promise<PullRequestBatch> {
      return readEach(items, (item) => getPullRequest({ ...item, signal: options.signal }));
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

export function githubClientForUser(options: ProviderBindOptions): GithubClient {
  const { userId, retry } = options;

  const resolveToken = async () => {
    const { token } = await getInstallationTokenForUser(userId, options.accountRef);

    return { token: redacted(token) };
  };

  return createGithubClient({ resolveToken, retry });
}
