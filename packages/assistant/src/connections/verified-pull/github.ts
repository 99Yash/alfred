import {
  canonicalizeGithubPullRequestUrl,
  parseGithubPullRequestUrl,
  type DayShape,
} from "@alfred/contracts";
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
 * - Every merge, with or without a row, feeds the brief's `shipped` list directly from the read.
 * Not in `VERIFIED_PULLS`: that driver reads one deployment target per trigger mail.
 */

/** One merge the read proved. `url` is canonical. */
export interface GithubMergedPullRequest {
  url: string;
  title: string;
  repoFullName: string;
  number: number;
  mergedAt: Date;
}

/** A read that completed. `total` is the provider's count, which can exceed `items`. */
export interface GithubMergedRead {
  items: GithubMergedPullRequest[];
  total: number;
}

/**
 * The tool has no output schema, so the result is one text block of JSON. The 8,000-character
 * bound clips that block, so `fields` leaves out the body and one page stays near 5 KB.
 */
const SEARCH_PAGE_SIZE = 8;

const SEARCH_FIELDS = ["number", "title", "html_url", "pull_request"];

/** The `shipped` contract bounds a title at 300 characters. */
const MAX_TITLE_LENGTH = 300;

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

/** GitHub's `merged:` range takes whole seconds. */
function searchInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `null`: no ready connection, a fault, a clipped result, or a shape this build cannot read. */
async function readGithubMergedPullRequests(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<GithubMergedRead | null> {
  try {
    const connections = await listOwnedConnections(args.userId);

    // No issuer pin: the stored identity is GitHub's OAuth path, not the registry issuer.
    const connection = connections.find(
      (item) => builtInProviderForEndpoint(item.server.endpointUrl) === "github",
    );

    if (!connection || connection.status !== "ready") return null;

    const prepared = await getMcpConnectionManager().prepareToolCall(connection.id);

    const envelope = await prepared.call(
      {
        kind: "mcp",
        connectionId: connection.id,
        remoteName: "search_pull_requests",
        catalogRevision: prepared.catalog.revision,
      },
      {
        query: `is:pr is:merged author:@me merged:${searchInstant(args.windowStart)}..${searchInstant(args.windowEnd)}`,
        perPage: SEARCH_PAGE_SIZE,
        sort: "updated",
        order: "desc",
        fields: SEARCH_FIELDS,
      },
      { result: "structured" },
    );

    if (envelope.outcome !== "completed" || envelope.truncation) return null;

    const parsed = parseMcpToolResult(envelope.result, searchResultSchema);

    if (!parsed) return null;

    const items: GithubMergedPullRequest[] = [];

    for (const item of parsed.items) {
      const mergedAtText = item.pull_request?.merged_at;
      const mergedAt = mergedAtText ? new Date(mergedAtText) : null;

      // The query filters the window too. This keeps a provider-side drift out of the brief.
      if (
        !mergedAt ||
        Number.isNaN(mergedAt.getTime()) ||
        mergedAt < args.windowStart ||
        mergedAt > args.windowEnd
      ) {
        continue;
      }

      const url = canonicalizeGithubPullRequestUrl({ url: item.html_url });
      const parts = url ? parseGithubPullRequestUrl(url) : null;
      const title = item.title.trim().slice(0, MAX_TITLE_LENGTH);

      if (!url || !parts || parts.number !== item.number || !title) continue;

      items.push({ url, title, repoFullName: parts.repoFullName, number: parts.number, mergedAt });
    }

    return { items, total: Math.max(parsed.total_count, items.length) };
  } catch {
    return null;
  }
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

/** Read, then fold. Never throws: a failed fold keeps the read, and a failed read gives `null`. */
export async function gatherGithubMergedPullRequests(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<GithubMergedRead | null> {
  const read = await readGithubMergedPullRequests(args);

  if (!read || read.items.length === 0) return read;

  try {
    await foldGithubMergedPullRequests(args.userId, read.items);
  } catch {
    // The read is still proof for `shipped`. The next gather retries the fold.
  }

  return read;
}

/** The read's merges in the `shipped` shape, newest first. */
export function shippedFromGithubRead(read: GithubMergedRead, limit: number): DayShape["shipped"] {
  return read.items
    .toSorted((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime())
    .slice(0, limit)
    .map((item) => ({ title: item.title, url: item.url }));
}
