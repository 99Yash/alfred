import { toRecord } from "@alfred/contracts";
import type { BriefingSlot } from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefingRuns, briefings, documents, emailTriage } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

/**
 * Read-side helpers for the LLM-composed daily briefing.
 *
 * The watermark contract is the spine of this whole flow: each run for a
 * given `(user_id, slot)` consumes a delta — `documents.ingested_at >
 * last terminal `briefings.watermark_at`. Only sent/suppressed rows
 * advance that watermark; composed/failed rows are reprocessed.
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
    const meta = toRecord(r.metadata);
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
  const meta = toRecord(row.metadata);
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
  slot?: BriefingSlot | null;
}

export async function listPriorBriefings(
  args: ListPriorBriefingsArgs,
): Promise<PriorBriefingSummary[]> {
  const limit = args.limit ?? PRIOR_BRIEFINGS_DEFAULT_LIMIT;

  const conditions = [
    eq(briefings.userId, args.userId),
    inArray(briefings.status, ["sent", "suppressed"]),
  ];
  if (args.slot) conditions.push(eq(briefings.slot, args.slot));

  const rows = await db()
    .select({
      id: briefings.id,
      slot: briefings.slot,
      briefingDate: briefings.briefingDate,
      runAt: briefings.createdAt,
      breakingSummary: briefings.breakingSummary,
      fullBriefing: briefings.fullBriefing,
    })
    .from(briefings)
    .where(and(...conditions))
    .orderBy(desc(briefings.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    slot: row.slot,
    briefingDate: row.briefingDate,
    runAt: row.runAt,
    subject: row.fullBriefing?.headline ?? row.breakingSummary,
    bodyText: priorBriefingBodyText(row.fullBriefing, row.breakingSummary),
  }));
}

/**
 * Latest watermark for a (user, slot) pair. Null when this slot has
 * never reached a terminal consumed state for the user — the first-run
 * case picks up emails from the start of the day.
 */
export async function fetchLatestWatermark(args: {
  userId: string;
  slot: BriefingSlot;
}): Promise<Date | null> {
  const rows = await db()
    .select({ watermarkAt: briefings.watermarkAt })
    .from(briefings)
    .where(
      and(
        eq(briefings.userId, args.userId),
        eq(briefings.slot, args.slot),
        inArray(briefings.status, ["sent", "suppressed"]),
        isNotNull(briefings.watermarkAt),
      ),
    )
    .orderBy(desc(briefings.watermarkAt))
    .limit(1);
  return rows[0]?.watermarkAt ?? null;
}

function priorBriefingBodyText(
  fullBriefing: (typeof briefings.$inferSelect)["fullBriefing"],
  breakingSummary: string | null,
): string | null {
  if (!fullBriefing) return breakingSummary;
  const parts = [
    fullBriefing.headline,
    breakingSummary,
    ...fullBriefing.sections.map((section) => section.body),
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length ? parts.join("\n\n") : null;
}

interface RecordBriefingRunArgs {
  userId: string;
  slot: string;
  briefingDate: string;
  watermarkAt: Date;
  subject: string;
  bodyText: string;
  /** Markdown source of the composed body; HTML is rendered at send time. */
  bodyMarkdown: string;
  agentRunId: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  payload?: Record<string, unknown>;
  /**
   * Legacy `briefing_runs` status for the old smoke workflow.
   * `'dry_run'` persists the row for inspection without sending.
   */
  status?: "composed" | "dry_run";
}

/**
 * Legacy-only insert for the old `daily-briefing` smoke path. ADR-0048
 * makes `briefings` canonical; new product code should write terminal
 * sent/suppressed rows there instead.
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
      bodyMarkdown: args.bodyMarkdown,
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
