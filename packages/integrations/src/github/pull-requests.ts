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

interface SearchIssuesItem {
  number: number;
  title: string;
  html_url: string;
  state: string;
  created_at: string;
  closed_at: string | null;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

interface SearchIssuesResponse {
  total_count: number;
  incomplete_results: boolean;
  items: SearchIssuesItem[];
}

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
    const body = await res.text().catch(() => "");
    throw new Error(`[github] ${res.status} search/issues :: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as SearchIssuesResponse;
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
