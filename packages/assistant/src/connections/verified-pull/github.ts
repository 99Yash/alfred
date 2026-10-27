import {
  canonicalizeGithubPullRequestUrl,
  DAY_SHAPE_TITLE_MAX,
  githubSearchDateTime,
  parseGithubPullRequestUrl,
  type DayShape,
} from "@alfred/contracts";
import { logger } from "@alfred/logging";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
  parseMcpToolResult,
} from "../mcp";
import {
  deliveryInstantNow,
  GITHUB_MERGED_PULL_READ_EVENT_TYPE,
  objectStateStore,
  type GithubMergedPullReadEvent,
} from "../object-state";
import { z } from "zod";

/**
 * GitHub's half of the verified pull (ADR-0062 amendment 2026-10-27). Webhooks stay the only row
 * creator. At gather time, one search over the ready GitHub MCP connection reads the user's merged
 * pull requests in the window.
 * - A merge folds into an existing row only through its `pull_request_url` key.
 * - Every merge, with or without a row, feeds the brief's `shipped` list from the read.
 * Not in `VERIFIED_PULLS`: that driver reads one deployment target per trigger mail, and this read
 * has no trigger. The read calls the connection manager directly, as Railway's reads do, so it
 * bypasses the broker and the `mcp_invocation` ledger; the amendment records that carve-out.
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

/** Bounds prepare + call. The client's own request timeout (`MCP_DEFAULT_REQUEST_TIMEOUT_MS`) fires first for the call. */
const GITHUB_MERGED_READ_TIMEOUT_MS = 60_000;

/**
 * The tool has no output schema, so the result is one text block of JSON. The 8,000-character
 * bound clips that block, so `fields` leaves out the body and one page stays under it.
 */
const SEARCH_PAGE_SIZE = 8;

const SEARCH_FIELDS = ["number", "title", "html_url", "pull_request"] as const;

const searchResultSchema = z.object({
  total_count: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      html_url: z.string(),
      pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
    }),
  ),
});

/**
 * The read. Never returns a partial list: one item this build cannot read fails the whole read,
 * and the store fallback takes over (ADR-0062 amendment). Throws on a transport fault.
 */
async function readGithubMergedPullRequests(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<GithubMergedReadOutcome> {
  const connections = await listOwnedConnections(args.userId);

  // No issuer pin: the stored identity is GitHub's OAuth path, not the registry issuer.
  const connection = connections.find(
    (item) => builtInProviderForEndpoint(item.server.endpointUrl) === "github",
  );

  if (!connection || connection.status !== "ready") return { status: "no_connection" };

  const deadline = AbortSignal.timeout(GITHUB_MERGED_READ_TIMEOUT_MS);

  const prepared = await getMcpConnectionManager().prepareToolCall(connection.id, deadline);

  const envelope = await prepared.call(
    {
      kind: "mcp",
      connectionId: connection.id,
      remoteName: "search_pull_requests",
      catalogRevision: prepared.catalog.revision,
    },
    {
      // GitHub documents the `+00:00` date-time form (ADR-0068), which `githubSearchDateTime` emits.
      query: `is:pr is:merged author:@me merged:${githubSearchDateTime(args.windowStart)}..${githubSearchDateTime(args.windowEnd)}`,
      perPage: SEARCH_PAGE_SIZE,
      sort: "updated",
      order: "desc",
      fields: SEARCH_FIELDS,
    },
    { result: "structured", signal: deadline },
  );

  if (envelope.outcome !== "completed" || envelope.truncation) return { status: "truncated" };

  const parsed = parseMcpToolResult(envelope.result, searchResultSchema);

  if (!parsed) return { status: "bad_shape", detail: "schema mismatch" };

  const items: GithubMergedPullRequest[] = [];

  for (const item of parsed.items) {
    const mergedAtText = item.pull_request?.merged_at;
    const mergedAt = mergedAtText ? new Date(mergedAtText) : null;

    // The query filters the window too, so a drop here is provider drift or a shape this build
    // cannot read. One drop fails the whole read: the read never gives a partial list.
    if (
      !mergedAt ||
      Number.isNaN(mergedAt.getTime()) ||
      mergedAt < args.windowStart ||
      mergedAt > args.windowEnd
    ) {
      return { status: "bad_shape", detail: "unreadable or out-of-window merged_at" };
    }

    const url = canonicalizeGithubPullRequestUrl({ url: item.html_url });
    const parts = url ? parseGithubPullRequestUrl(url) : null;
    const title = item.title.trim().slice(0, DAY_SHAPE_TITLE_MAX);

    if (!url || !parts || parts.number !== item.number || !title) {
      return { status: "bad_shape", detail: "unreadable url, number, or title" };
    }

    items.push({ url, title, repoFullName: parts.repoFullName, number: parts.number, mergedAt });
  }

  return {
    status: "completed",
    read: { items, total: Math.max(parsed.total_count, items.length) },
  };
}

/**
 * Fold each read merge into the row that its URL key resolves. A merge with no row mints nothing.
 * A resolved row is skipped, and the store's guards decide the rest. Returns the fold count.
 */
async function foldGithubMergedPullRequests(
  userId: string,
  items: readonly GithubMergedPullRequest[],
): Promise<number> {
  const refs = await objectStateStore.resolveByKeys(
    userId,
    "github",
    "pull_request_url",
    items.map((item) => item.url),
  );

  const pullRefs = [...refs.values()].filter((ref) => ref.kind === "pull_request");
  const states = await objectStateStore.getStates(userId, pullRefs);
  let folded = 0;

  for (const item of items) {
    const ref = refs.get(item.url);
    const state = ref ? states.get(ref.objectId) : undefined;

    // A merged row is final. A re-fold would only move its `stateDeliveredAt` into a later window,
    // and the store fallback would then list it as shipped a second time.
    if (!ref || !state || state.stateCategory === "resolved") continue; // drift-ok: skips a no-op write, not a closure test

    const event: GithubMergedPullReadEvent = {
      provider: "github",
      eventType: GITHUB_MERGED_PULL_READ_EVENT_TYPE,
      payload: { externalId: ref.externalId, ...item },
    };

    await objectStateStore.applyEvent({ userId, event, deliveredAt: deliveryInstantNow() });
    folded += 1;
  }

  return folded;
}

/**
 * Read, then fold. Never throws: a failed fold keeps the read, and a failed read becomes
 * `failed`. Every fault is logged under the `err` key, so nothing is swallowed.
 */
export async function gatherGithubMergedPullRequests(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<GithubMergedReadOutcome> {
  let outcome: GithubMergedReadOutcome;

  try {
    outcome = await readGithubMergedPullRequests(args);
  } catch (err) {
    outcome = { status: "failed", err };
  }

  if (outcome.status === "failed") {
    logger.warn({ err: outcome.err }, "[github.merged] read failed");
  } else if (outcome.status === "truncated" || outcome.status === "bad_shape") {
    logger.warn(
      outcome.status === "bad_shape" ? { detail: outcome.detail } : {},
      "[github.merged] unreadable result; shipped falls back to the store",
    );
  }

  if (outcome.status !== "completed" || outcome.read.items.length === 0) return outcome;

  try {
    await foldGithubMergedPullRequests(args.userId, outcome.read.items);
  } catch (err) {
    // The read is still proof for `shipped`. The next gather retries the fold.
    logger.warn({ err }, "[github.merged] fold failed");
  }

  return outcome;
}

/** The read's merges in the `shipped` shape, newest by merge time first. */
export function shippedFromGithubRead(read: GithubMergedRead, limit: number): DayShape["shipped"] {
  return read.items
    .toSorted((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime())
    .slice(0, limit)
    .map((item) => ({ title: item.title, url: item.url }));
}
