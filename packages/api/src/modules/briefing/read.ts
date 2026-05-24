import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage } from "@alfred/db/schemas";
import { and, desc, eq, gt, sql } from "drizzle-orm";

/**
 * Read-side helpers for the LLM-composed daily briefing.
 *
 * The watermark contract is the spine of this whole flow: each run for a
 * given `(user_id, slot)` consumes a delta — `documents.ingested_at >
 * last_composed_watermark_at`. The next run for *either* slot reads its
 * own slot's watermark; emails surface in whichever slot ran next.
 *
 * `list_prior_briefings` is the memory side — the agent reads its own
 * recent compositions so an evening briefing can reference what the
 * morning surfaced ("Morning mentioned the Deepanshu follow-up...")
 * without re-deriving from the inbox.
 */

const PRIOR_BRIEFINGS_DEFAULT_LIMIT = 5;
const EMAIL_LIST_DEFAULT_LIMIT = 60;
const READ_EMAIL_BODY_CHAR_CAP = 8_000;

export interface EmailListItem {
  documentId: string;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  triageCategory: string | null;
  triageRationale: string | null;
  authoredAt: Date | null;
  ingestedAt: Date;
  threadId: string | null;
  /** Character length of the full body. Lets the agent decide when read_email is worth a tool call. */
  contentLength: number;
}

export interface EmailReadResult {
  documentId: string;
  subject: string | null;
  from: string | null;
  authoredAt: Date | null;
  body: string;
  /** True when the body was truncated to fit the cap. */
  truncated: boolean;
}

export interface PriorBriefingSummary {
  id: string;
  slot: string;
  briefingDate: string;
  runAt: Date;
  subject: string | null;
  bodyText: string | null;
}

interface ListEmailsSinceArgs {
  userId: string;
  /** Exclusive lower bound; pass the previous run's `watermark_at`. Null = no lower bound. */
  sinceIngestedAt: Date | null;
  /** Inclusive upper bound. Defaults to now — the agent should freeze this per run. */
  untilIngestedAt: Date;
  limit?: number;
}

export async function listEmailsSinceWatermark(
  args: ListEmailsSinceArgs,
): Promise<EmailListItem[]> {
  const limit = args.limit ?? EMAIL_LIST_DEFAULT_LIMIT;

  const conditions = [
    eq(documents.userId, args.userId),
    eq(documents.source, "gmail"),
    sql`${documents.ingestedAt} <= ${args.untilIngestedAt}`,
  ];
  if (args.sinceIngestedAt) {
    conditions.push(gt(documents.ingestedAt, args.sinceIngestedAt));
  }

  const rows = await db()
    .select({
      documentId: documents.id,
      subject: documents.title,
      authoredAt: documents.authoredAt,
      ingestedAt: documents.ingestedAt,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
      contentLength: sql<number>`length(${documents.content})`,
      triageCategory: emailTriage.category,
      triageRationale: emailTriage.rationale,
    })
    .from(documents)
    .leftJoin(
      emailTriage,
      and(
        eq(emailTriage.userId, documents.userId),
        eq(emailTriage.sourceThreadId, documents.sourceThreadId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(documents.ingestedAt))
    .limit(limit);

  return rows.map((r) => {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    return {
      documentId: r.documentId,
      subject: r.subject,
      from: typeof meta.from === "string" ? meta.from : null,
      snippet: typeof meta.snippet === "string" ? meta.snippet : null,
      triageCategory: r.triageCategory,
      triageRationale: r.triageRationale,
      authoredAt: r.authoredAt,
      ingestedAt: r.ingestedAt,
      threadId: r.sourceThreadId,
      contentLength: Number(r.contentLength ?? 0),
    } satisfies EmailListItem;
  });
}

export async function readEmailDocument(args: {
  userId: string;
  documentId: string;
}): Promise<EmailReadResult | null> {
  const rows = await db()
    .select({
      documentId: documents.id,
      subject: documents.title,
      authoredAt: documents.authoredAt,
      content: documents.content,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(eq(documents.id, args.documentId), eq(documents.userId, args.userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const full = row.content ?? "";
  const truncated = full.length > READ_EMAIL_BODY_CHAR_CAP;
  return {
    documentId: row.documentId,
    subject: row.subject,
    from: typeof meta.from === "string" ? meta.from : null,
    authoredAt: row.authoredAt,
    body: truncated ? full.slice(0, READ_EMAIL_BODY_CHAR_CAP) : full,
    truncated,
  };
}

interface ListPriorBriefingsArgs {
  userId: string;
  limit?: number;
  /** Optional slot filter — null returns both slots interleaved. */
  slot?: string | null;
}

export async function listPriorBriefings(
  args: ListPriorBriefingsArgs,
): Promise<PriorBriefingSummary[]> {
  const limit = args.limit ?? PRIOR_BRIEFINGS_DEFAULT_LIMIT;

  const conditions = [eq(briefingRuns.userId, args.userId), eq(briefingRuns.status, "composed")];
  if (args.slot) conditions.push(eq(briefingRuns.slot, args.slot));

  const rows = await db()
    .select({
      id: briefingRuns.id,
      slot: briefingRuns.slot,
      briefingDate: briefingRuns.briefingDate,
      runAt: briefingRuns.runAt,
      subject: briefingRuns.subject,
      bodyText: briefingRuns.bodyText,
    })
    .from(briefingRuns)
    .where(and(...conditions))
    .orderBy(desc(briefingRuns.runAt))
    .limit(limit);

  return rows;
}

/**
 * Latest watermark for a (user, slot) pair. Null when this slot has
 * never composed successfully for the user — the first-run case picks
 * up emails from the start of the day.
 */
export async function fetchLatestWatermark(args: {
  userId: string;
  slot: string;
}): Promise<Date | null> {
  const rows = await db()
    .select({ watermarkAt: briefingRuns.watermarkAt })
    .from(briefingRuns)
    .where(
      and(
        eq(briefingRuns.userId, args.userId),
        eq(briefingRuns.slot, args.slot),
        eq(briefingRuns.status, "composed"),
      ),
    )
    .orderBy(desc(briefingRuns.runAt))
    .limit(1);
  return rows[0]?.watermarkAt ?? null;
}

interface RecordBriefingRunArgs {
  userId: string;
  slot: string;
  briefingDate: string;
  watermarkAt: Date;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  agentRunId: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  payload?: Record<string, unknown>;
  /**
   * `'composed'` (default) marks the row as the canonical output for
   * (user, slot, date) and anchors the next watermark. `'dry_run'`
   * persists the row for inspection but is invisible to
   * `fetchLatestWatermark` (the index is partial on `status='composed'`)
   * — used by the smoke runner for prompt iteration without consuming
   * the email delta.
   */
  status?: "composed" | "dry_run";
}

/**
 * Insert a `briefing_runs` row. Default status is `composed`; the
 * dry-run variant (`status='dry_run'`) writes the same payload but
 * stays outside the watermark + per-date uniqueness indexes (both
 * partial on `status='composed'`), so a smoke run doesn't conflict with
 * a later real run for the same day.
 *
 * Called only after the agent emits a final body via `dump_briefing`;
 * failed runs do not write here so the watermark stays anchored on the
 * last successful compose. Inserted before `notify()` so the row exists
 * even if the email send fails — the agent's work isn't lost.
 */
export async function recordBriefingRun(args: RecordBriefingRunArgs): Promise<{ id: string }> {
  const rows = await db()
    .insert(briefingRuns)
    .values({
      userId: args.userId,
      slot: args.slot,
      briefingDate: args.briefingDate,
      watermarkAt: args.watermarkAt,
      status: args.status ?? "composed",
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      agentRunId: args.agentRunId,
      modelId: args.modelId,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      payload: args.payload ?? {},
    })
    .returning({ id: briefingRuns.id });
  const row = rows[0];
  if (!row) throw new Error("[briefing.read] insert returned no row");
  return { id: row.id };
}
