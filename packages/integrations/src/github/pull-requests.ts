import { httpErrorFromResponse } from "@alfred/contracts";
import { z } from "zod";

/**
 * GitHub pull-request reads via the REST Search API. Read-only; uses the
 * user's stored access token. Mirrors the thin-fetch style of the Google
 * Drive helper — no Octokit dependency, just `fetch` with the documented
 * headers (GitHub rejects requests without a `User-Agent`).
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "alfred-app";

export interface SearchPullRequestsArgs {
  accessToken: string;
  /** A fully-formed GitHub issues-search query (already scoped with `is:pr`). */
  q: string;
  perPage?: number;
  sort?: "created" | "updated" | "comments";
  order?: "asc" | "desc";
}

export interface PullRequestHit {
  number: number;
  title: string;
  url: string;
  /** GitHub search reports `open` | `closed`; `merged` is derived below. */
  state: string;
  merged: boolean;
  repository: string;
  createdAt: string;
  closedAt: string | null;
}

export interface SearchPullRequestsResult {
  totalCount: number;
  incompleteResults: boolean;
  /** Echo of the resolved query so callers can show/verify what ran. */
  query: string;
  items: PullRequestHit[];
}

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

export async function searchPullRequests(
  args: SearchPullRequestsArgs,
): Promise<SearchPullRequestsResult> {
  const url = new URL(`${GITHUB_API}/search/issues`);
  url.searchParams.set("q", args.q);
  url.searchParams.set("per_page", String(Math.min(Math.max(args.perPage ?? 30, 1), 100)));
  if (args.sort) url.searchParams.set("sort", args.sort);
  if (args.order) url.searchParams.set("order", args.order);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("github", res, { url: "search/issues" });
  }
  const json = searchIssuesResponseSchema.parse(await res.json());
  const items: PullRequestHit[] = (json.items ?? []).map((it) => ({
    number: it.number,
    title: it.title,
    url: it.html_url,
    state: it.state,
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
