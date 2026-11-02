import type { GithubMergedPullReadEvent } from "../object-state";

/**
 * The result types of the GitHub merged read (`./github`). They are in their own file so that a
 * reader of the result, for example the activity coverage, does not load the MCP client.
 */

/** One merge the read proved. `url` is canonical. Derived from the event payload, so the fold input and the reducer cannot drift. */
export type GithubMergedPullRequest = Omit<GithubMergedPullReadEvent["payload"], "externalId">;

/** A read that completed. `total` is the provider's count, which can exceed `items`. */
export interface GithubMergedRead {
  items: GithubMergedPullRequest[];
  total: number;
}

/**
 * Each state its own variant (review checklist): a miss and a fault are two values.
 * `no_connection` is the miss — GitHub is not connected, and the brief behaves as before.
 * `truncated`, `bad_shape`, and `failed` are faults — the bounds clipped the result, the result is
 * unreadable or partial, or the call threw. Only `completed` carries a read.
 */
export type GithubMergedReadOutcome =
  | { status: "no_connection" }
  | { status: "truncated" }
  | { status: "bad_shape"; detail: string }
  | { status: "failed"; err: unknown }
  | { status: "completed"; read: GithubMergedRead };
