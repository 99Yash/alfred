import { canonicalizeIdentityValue, parseDocumentMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, asc, eq, gt, gte, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { loadCredentialRowsByProvider } from "../availability";
import type { GithubActivityDocument, GithubSelf } from "./github-activity";

/**
 * Reads for the GitHub activity reducer. The body comes from `documents.raw`, not
 * `event_receipts.payload`: the payload reaper releases a receipt body only when its document
 * keeps it, and receipts from before migration 0167 were deleted by a credential cascade, but
 * their documents stayed (ADR-0118 residual risk).
 */

const GITHUB_DOCUMENT_COLUMNS = {
  id: documents.id,
  userId: documents.userId,
  sourceId: documents.sourceId,
  accountId: documents.accountId,
  authoredAt: documents.authoredAt,
  raw: documents.raw,
  metadata: documents.metadata,
};

type GithubDocumentRow = GithubActivityDocument & { readonly metadata: unknown };

function toActivityDocument({
  metadata,
  ...row
}: Omit<GithubDocumentRow, "kind">): GithubActivityDocument | null {
  const kind = parseDocumentMetadata({ source: "github", metadata }).metadata.kind;

  return kind ? { ...row, kind } : null;
}

/** The document of one GitHub receipt, or `null` before it exists. */
export async function readGithubActivityDocument(
  userId: string,
  receiptId: string,
): Promise<GithubActivityDocument | null> {
  const [row] = await db()
    .select(GITHUB_DOCUMENT_COLUMNS)
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "github"),
        eq(documents.sourceId, receiptId),
      ),
    )
    .limit(1);

  return row ? toActivityDocument(row) : null;
}

/** Only the event kinds whose deliveries can be activity. Skips the `workflow_job` bulk. */
const ACTIVITY_KIND_FILTER: SQL = sql`(${documents.metadata}->>'kind' like 'pull_request%' or ${documents.metadata}->>'kind' like 'push%' or ${documents.metadata}->>'kind' like 'issues%')`;

/**
 * One page of every user's GitHub documents that can be activity, in `id` order. The replay reads
 * history through it. Order does not matter: each family key names one act, so a replay in any
 * order writes the same rows. `id`, not a timestamp: a JS `Date` cursor drops microseconds.
 */
export async function pageGithubActivityDocuments(args: {
  afterId: string | null;
  limit: number;
}): Promise<{ documents: GithubActivityDocument[]; nextId: string | null }> {
  const { afterId, limit } = args;

  const rows = await db()
    .select(GITHUB_DOCUMENT_COLUMNS)
    .from(documents)
    .where(
      and(
        eq(documents.source, "github"),
        ACTIVITY_KIND_FILTER,
        afterId ? gt(documents.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(documents.id))
    .limit(limit);

  const last = rows.at(-1);

  return {
    documents: rows.flatMap((row) => toActivityDocument(row) ?? []),
    nextId: last && rows.length === limit ? last.id : null,
  };
}

/**
 * The user's GitHub documents that can be activity and that arrived in `[start, end)`. Coverage
 * reads them to prove that the record holds each act.
 */
export async function readGithubActivityDocumentsBetween(args: {
  userId: string;
  start: Date;
  end: Date;
}): Promise<GithubActivityDocument[]> {
  const { userId, start, end } = args;

  const rows = await db()
    .select(GITHUB_DOCUMENT_COLUMNS)
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "github"),
        ACTIVITY_KIND_FILTER,
        gte(documents.authoredAt, start),
        lt(documents.authoredAt, end),
      ),
    );

  return rows.flatMap((row) => toActivityDocument(row) ?? []);
}

/**
 * The user's GitHub identity from the credential rows, plus the `github_username` fact. The fact
 * value is persisted JSON, so it arrives as `unknown`; a value that is not a string adds no login.
 */
export async function readGithubSelf(userId: string, githubUsername: unknown): Promise<GithubSelf> {
  const rows = (await loadCredentialRowsByProvider(userId)).get("github") ?? [];
  const logins = new Set<string>();

  for (const row of rows) {
    if (row.accountLabel) logins.add(canonicalizeIdentityValue("github_login", row.accountLabel));
  }

  const username = z.string().min(1).safeParse(githubUsername);

  if (username.success) logins.add(canonicalizeIdentityValue("github_login", username.data));

  return { userIds: new Set(rows.map((row) => row.accountId)), logins };
}
