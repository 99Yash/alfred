import {
  isTriageCategory,
  parseEmailAddress,
  scoreAttentionForItems,
  toRecord,
} from "@alfred/contracts";
import type {
  AttentionBand,
  BriefingGather,
  BriefingSlot,
  SignificanceBand,
  TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefingRuns, briefings, documents, emailTriage, type Briefing } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getSenderSignificanceBatch } from "../memory/significance";

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
/**
 * Lookback for the "already surfaced" continuation signal. 16h spans both
 * directions that produce same-thread repetition across consecutive briefings:
 * this morning → this evening (~10h) and last night → this morning (~12h).
 */
const SURFACED_LOOKBACK_MS = 16 * 60 * 60 * 1000;
/** Only the last few terminal briefings can fall inside the lookback window. */
const SURFACED_LOOKBACK_LIMIT = 4;

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
  /**
   * True when this thread already went out in a recent terminal briefing
   * (within {@link SURFACED_LOOKBACK_MS}). The continuation signal: the agent
   * should close the loop on it ("still no reply") or drop it, never
   * re-introduce it as fresh — that morning/evening duplication is what erodes
   * trust. Computed deterministically from prior briefings' persisted `gather`,
   * not from LLM prose-matching.
   */
  previouslySurfaced: boolean;
  /**
   * Presentation-layer demand band (ADR-0064 / #210) — `demanding | normal |
   * muted`, computed cross-row over the window via the shared scorer (category
   * base × recurrence decay; significance is folded in at Phase B). A `muted`
   * item is recurring machine noise / low-signal: the agent should not surface
   * it as demanding. Like {@link EmailListItem.previouslySurfaced}, this is a
   * deterministic ranking hint layered on top of the honest, immutable
   * `triageCategory` — it never re-tags.
   */
  attentionBand: AttentionBand;
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

  const [rows, surfacedThreadIds] = await Promise.all([
    db()
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
      .limit(limit),
    // Anchor the lookback on the run's frozen "until" instant so the signal is
    // deterministic with the rest of the window, not wall-clock at map time.
    listRecentlySurfacedThreadIds({ userId: args.userId, before: args.untilIngestedAt }),
  ]);

  const metas = rows.map((r) => toRecord(r.metadata));
  const senders = metas.map((meta) => (typeof meta.from === "string" ? meta.from : null));

  // Phase B (ADR-0064): fetch each distinct sender's precomputed significance so
  // the scorer demotes low-significance cold senders *within* their honest
  // category (the cold LinkedIn `awaiting_reply` drops to the ambient tail; a
  // known-important sender keeps it demanding). One read per distinct address,
  // deduped; an unscored / non-human / unknown sender degrades to neutral —
  // exactly the Phase-A intrinsic-only behavior.
  const significanceByAddress = await loadSignificanceBands(args.userId, senders);
  const bandFor = (from: string | null): SignificanceBand | null => {
    const address = parseEmailAddress(from);
    return address ? (significanceByAddress.get(address) ?? null) : null;
  };

  // Score the window together so recurrence (a cross-row property) is computed
  // off the same rows the agent sees. Untriaged rows (the defensive left-join
  // miss) carry no demand signal → `normal`, never demoted on a guess.
  const attention = scoreAttentionForItems(
    rows.map((r, i) => ({
      sender: senders[i],
      subject: r.subject,
      category: toTriageCategory(r.triageCategory) ?? "fyi",
      significanceBand: bandFor(senders[i] ?? null),
      // Chronological key for recurrence (rows arrive newest-first); fall back
      // to ingest time when the message carries no authored timestamp.
      occurredAtMs: (r.authoredAt ?? r.ingestedAt)?.getTime() ?? null,
    })),
  );

  return rows.map((r, i) => {
    const meta = metas[i] ?? {};
    return {
      documentId: r.documentId,
      subject: r.subject,
      from: senders[i] ?? null,
      snippet: typeof meta.snippet === "string" ? meta.snippet : null,
      triageCategory: r.triageCategory,
      triageRationale: r.triageRationale,
      authoredAt: r.authoredAt,
      ingestedAt: r.ingestedAt,
      threadId: r.sourceThreadId,
      previouslySurfaced: r.sourceThreadId ? surfacedThreadIds.has(r.sourceThreadId) : false,
      attentionBand: toTriageCategory(r.triageCategory) ? (attention[i]?.band ?? "normal") : "normal",
      contentLength: Number(r.contentLength ?? 0),
    } satisfies EmailListItem;
  });
}

/** A triage category string narrowed to the contract enum, or null if unknown/absent. */
function toTriageCategory(category: string | null): TriageCategory | null {
  return isTriageCategory(category) ? category : null;
}

/**
 * Resolve `address → SignificanceBand` for the distinct senders in a window.
 * Reads the precomputed significance scalar (ADR-0057/0059) for all distinct
 * addresses in one batched alias query via {@link getSenderSignificanceBatch} —
 * never recomputes, and avoids an N+1 over the (up to `limit`-many) senders one
 * `list_emails_since` tool call can surface. Senders with no graph row (or a row
 * not yet scored) are simply absent from the map, which the caller treats as
 * neutral (no demotion).
 */
async function loadSignificanceBands(
  userId: string,
  rawSenders: ReadonlyArray<string | null>,
): Promise<Map<string, SignificanceBand>> {
  const addresses = new Set<string>();
  for (const raw of rawSenders) {
    const address = parseEmailAddress(raw);
    if (address) addresses.add(address);
  }
  if (addresses.size === 0) return new Map();

  const significanceByAddress = await getSenderSignificanceBatch(userId, [...addresses]);

  const out = new Map<string, SignificanceBand>();
  for (const [address, significance] of significanceByAddress) {
    out.set(address, significance.band);
  }
  return out;
}

/**
 * Thread ids surfaced in a recent terminal briefing — the set the next slot
 * should treat as continuations, not fresh items. Sourced from the persisted
 * `gather.email.categories[*][].threadId` of `sent`/`suppressed` briefings
 * created within the lookback window. This is the deterministic backbone of the
 * `previouslySurfaced` flag on {@link EmailListItem}; it replaces relying on the
 * agent to fuzzy-match prose across `list_prior_briefings`.
 */
export async function listRecentlySurfacedThreadIds(args: {
  userId: string;
  /** Upper bound the lookback window subtracts from — pass the run's frozen "until". */
  before: Date;
  lookbackMs?: number;
}): Promise<Set<string>> {
  const lookbackMs = args.lookbackMs ?? SURFACED_LOOKBACK_MS;
  const since = new Date(args.before.getTime() - lookbackMs);

  const rows = await db()
    .select({ gather: briefings.gather })
    .from(briefings)
    .where(
      and(
        eq(briefings.userId, args.userId),
        inArray(briefings.status, ["sent", "suppressed"]),
        gt(briefings.createdAt, since),
      ),
    )
    .orderBy(desc(briefings.createdAt))
    .limit(SURFACED_LOOKBACK_LIMIT);

  return collectSurfacedThreadIds(rows.map((row) => row.gather));
}

/**
 * Pure extraction of every thread id referenced across a set of gather
 * payloads. Split out from {@link listRecentlySurfacedThreadIds} so the dedup
 * core is unit-testable without a database. Null gathers (suppressed rows that
 * never gathered) and per-category absences are tolerated.
 */
export function collectSurfacedThreadIds(gathers: Array<BriefingGather | null>): Set<string> {
  const ids = new Set<string>();
  for (const gather of gathers) {
    const categories = gather?.email.categories;
    if (!categories) continue;
    for (const items of Object.values(categories)) {
      for (const item of items ?? []) {
        if (item.threadId) ids.add(item.threadId);
      }
    }
  }
  return ids;
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
  fullBriefing: Briefing["fullBriefing"],
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
