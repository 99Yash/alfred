import {
  deriveLoopKey,
  isTriageCategory,
  parseEmailAddress,
  parseGmailDocumentMetadata,
  scoreAttentionForItems,
  toMessage,
} from "@alfred/contracts";
import type {
  AttentionBand,
  BriefingGather,
  BriefingSlot,
  FullBriefing,
  IanaTimezone,
  SignificanceBand,
  TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings, documents, emailTriage, type Briefing } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  findSenderSuppression,
  getSenderSignificanceBatch,
  listActiveSuppressionInstructions,
} from "../knowledge";
import { inZone } from "@alfred/assistant/time";

/**
 * Read helpers for the daily briefing.
 * Each run for `(user_id, slot)` reads documents ingested after the last
 * sent or suppressed `watermark_at`. Composed and failed rows are reprocessed.
 */

const PRIOR_BRIEFINGS_DEFAULT_LIMIT = 5;

const EMAIL_LIST_DEFAULT_LIMIT = 60;

/** Larger page while skipping suppressed senders. */
const EMAIL_LIST_SUPPRESSION_PAGE_SIZE = 200;

const READ_EMAIL_BODY_CHAR_CAP = 8_000;

/** 16h covers both morning to evening (~10h) and last night to morning (~12h). */
const SURFACED_LOOKBACK_MS = 16 * 60 * 60 * 1000;

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
  /**
   * Receipt time in the user's zone, from Gmail `internalDate`, not the sender's `Date` header.
   * Null when there is no timezone or receipt time.
   */
  receivedAtLocal: string | null;
  /** `UNREAD` label present. Null when no labels were captured, so read-state is unknown. */
  unread: boolean | null;
  threadId: string | null;
  /**
   * This loop went out in a recent sent briefing. Matches on thread id or
   * {@link deriveLoopKey}, so a tool that re-notifies on a new thread still counts.
   */
  previouslySurfaced: boolean;
  /** Demand band (ADR-0064). A ranking hint only. It never changes `triageCategory`. */
  attentionBand: AttentionBand;
  /** Lets the agent decide if a `read_email` call is worth it. */
  contentLength: number;
}

export interface EmailReadResult {
  documentId: string;
  subject: string | null;
  from: string | null;
  authoredAt: Date | null;
  body: string;
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
  /** Inclusive upper bound. Freeze it per run. */
  untilIngestedAt: Date;
  /** Renders `receivedAtLocal`. Omit it and `receivedAtLocal` stays null. */
  timezone?: IanaTimezone;
  limit?: number;
}

interface EmailListRow {
  documentId: string;
  subject: string | null;
  authoredAt: Date | null;
  ingestedAt: Date;
  sourceThreadId: string | null;
  accountId: string | null;
  metadata: unknown;
  gmailInternalDate: string | null;
  contentLength: number;
  triageCategory: string | null;
  triageRationale: string | null;
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

  const [surfaced, suppressionInstructions] = await Promise.all([
    // Anchor on the frozen "until" so the signal does not depend on wall-clock time.
    listRecentlySurfacedKeys({ userId: args.userId, before: args.untilIngestedAt }),
    // The agent writes prose from this list, not from `gather`, so suppression applies here too.
    listActiveSuppressionInstructions(args.userId),
  ]);

  const rows: EmailListRow[] = [];
  const hasSuppression = suppressionInstructions.length > 0;
  const pageSize = hasSuppression ? Math.max(limit, EMAIL_LIST_SUPPRESSION_PAGE_SIZE) : limit;
  let offset = 0;

  while (rows.length < limit) {
    const page = await db()
      .select({
        documentId: documents.id,
        subject: documents.title,
        authoredAt: documents.authoredAt,
        ingestedAt: documents.ingestedAt,
        sourceThreadId: documents.sourceThreadId,
        accountId: documents.accountId,
        metadata: documents.metadata,
        gmailInternalDate: sql<
          string | null
        >`coalesce(${documents.metadata}->>'internalDate', ${documents.raw}->>'internalDate')`,
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
      .orderBy(desc(documents.ingestedAt), desc(documents.id))
      .limit(pageSize)
      .offset(offset);

    if (page.length === 0) break;
    offset += page.length;

    // Drop suppressed senders before scoring so they do not skew recurrence.
    for (const row of page) {
      if (hasSuppression) {
        const from = parseGmailDocumentMetadata(row.metadata).from;

        const suppressed = findSenderSuppression(suppressionInstructions, {
          senderEmail: from ?? null,
          accountId: row.accountId,
          effect: "exclude_briefing_priority",
        });

        if (suppressed) continue;
      }

      rows.push(row);

      if (rows.length >= limit) break;
    }

    if (!hasSuppression || page.length < pageSize) break;
  }

  const metas = rows.map((r) => parseGmailDocumentMetadata(r.metadata));
  const senders = metas.map((meta) => meta.from ?? null);

  // Significance demotes cold senders inside their category (ADR-0064).
  // An unscored sender is neutral.
  const significanceByAddress = await loadSignificanceBands(args.userId, senders);

  const bandFor = (from: string | null): SignificanceBand | null => {
    const address = parseEmailAddress(from);

    return address ? (significanceByAddress.get(address) ?? null) : null;
  };

  // Score the whole window together: recurrence is cross-row. Untriaged rows stay `normal`.
  const attention = scoreAttentionForItems(
    rows.map((r, i) => ({
      sender: senders[i],
      subject: r.subject,
      category: toTriageCategory(r.triageCategory) ?? "fyi",
      significanceBand: bandFor(senders[i] ?? null),
      // Rows arrive newest-first.
      occurredAtMs: (r.authoredAt ?? r.ingestedAt)?.getTime() ?? null,
    })),
  );

  return rows.map((r, i) => {
    const meta = metas[i] ?? {};
    // Match on thread id or loop key: a tool can re-notify on a new thread.
    const loopKey = deriveLoopKey(r.subject, { sender: senders[i] ?? null });
    const surfacedByThread = r.sourceThreadId ? surfaced.threadIds.has(r.sourceThreadId) : false;
    const surfacedByLoop = loopKey ? surfaced.loopKeys.has(loopKey) : false;
    const receiptInstant = gmailReceivedAt(r.gmailInternalDate);

    return {
      documentId: r.documentId,
      subject: r.subject,
      from: senders[i] ?? null,
      snippet: meta.snippet ?? null,
      triageCategory: r.triageCategory,
      triageRationale: r.triageRationale,
      authoredAt: r.authoredAt,
      ingestedAt: r.ingestedAt,
      receivedAtLocal:
        args.timezone && receiptInstant ? inZone(args.timezone).format(receiptInstant) : null,
      unread: unreadFromLabels(meta.labelIds),
      threadId: r.sourceThreadId,
      previouslySurfaced: surfacedByThread || surfacedByLoop,
      attentionBand: toTriageCategory(r.triageCategory)
        ? (attention[i]?.band ?? "normal")
        : "normal",
      contentLength: Number(r.contentLength ?? 0),
    } satisfies EmailListItem;
  });
}

function toTriageCategory(category: string | null): TriageCategory | null {
  return isTriageCategory(category) ? category : null;
}

/** Null when the row has no `labelIds` (older rows), so read-state is unknown. */
function unreadFromLabels(labelIds: readonly string[] | undefined): boolean | null {
  return labelIds ? labelIds.includes("UNREAD") : null;
}

/**
 * Gmail receipt time from `internalDate`, not the RFC `Date` header.
 * Null when absent: `authoredAt` and `ingestedAt` are not receipt times.
 */
function gmailReceivedAt(internalDate: string | null): Date | null {
  if (!internalDate) return null;
  const epochMs = Number(internalDate);

  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** One batched read of precomputed significance. Missing senders are absent from the map. */
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

/** One already-gathered priority email, reduced to the scorer's inputs. */
export interface PriorityEmailDemandItem {
  /** Raw `From`; a display name is fine. */
  sender: string | null;
  subject: string | null;
  /** Context for pins such as payment failures. */
  snippet?: string | null;
  category: TriageCategory;
  /** Null falls back to input order. */
  occurredAtMs: number | null;
}

export interface PriorityEmailDemand {
  demandingCount: number;
  /** `muted` when the set is empty. */
  topBand: AttentionBand;
}

/**
 * Score gathered priority emails for the morning suppression gate (ADR-0064).
 * Uses the same scorer as `list_emails_since`, so the gate and the agent agree on "demanding".
 * Pass the whole window in one call: recurrence is cross-row.
 * Failed or due payments pin to demanding. A significance read failure falls back to category only.
 */
export async function scorePriorityEmailDemand(
  userId: string,
  items: readonly PriorityEmailDemandItem[],
): Promise<PriorityEmailDemand> {
  if (items.length === 0) return { demandingCount: 0, topBand: "muted" };

  let bands: Map<string, SignificanceBand> = new Map();

  try {
    bands = await loadSignificanceBands(
      userId,
      items.map((item) => item.sender),
    );
  } catch (err) {
    // Never fail the briefing over significance.
    console.warn("[briefing.read] significance unavailable for suppression gate:", toMessage(err));
  }

  const bandFor = (from: string | null): SignificanceBand | null => {
    const address = parseEmailAddress(from);

    return address ? (bands.get(address) ?? null) : null;
  };

  const scored = scoreAttentionForItems(
    items.map((item) => ({
      sender: item.sender,
      subject: item.subject,
      category: item.category,
      significanceBand: bandFor(item.sender),
      occurredAtMs: item.occurredAtMs,
      pinnedDemanding: isDemandingPayment(item),
    })),
  );

  let demandingCount = 0;
  let topScore = -1;
  let topBand: AttentionBand = "muted";

  for (const result of scored) {
    if (result.band === "demanding") demandingCount += 1;

    if (result.score > topScore) {
      topScore = result.score;
      topBand = result.band;
    }
  }

  return { demandingCount, topBand };
}

const ACTIONABLE_PAYMENT_RE =
  /\b(?:payment|card|invoice|bill|billing|subscription|charge)\b[\s\S]{0,120}\b(?:fail(?:ed|ure)?|declin(?:ed|e)|past due|overdue|unpaid|due now|due today|unable to process|could(?: not|n't) process|update|action required|required action|requires? attention|needs? attention)\b|\b(?:fail(?:ed|ure)?|declin(?:ed|e)|past due|overdue|unpaid|action required|required action|requires? attention|needs? attention|unable to process|could(?: not|n't) process)\b[\s\S]{0,120}\b(?:payment|card|invoice|bill|billing|subscription|charge)\b/i;

function isDemandingPayment(item: PriorityEmailDemandItem): boolean {
  if (item.category !== "payment") return false;
  const text = [item.subject, item.snippet].filter(Boolean).join("\n");

  return ACTIONABLE_PAYMENT_RE.test(text);
}

/**
 * Morning is quiet, and suppresses without an LLM call, when nothing is demanding,
 * there is no integration activity, and no meetings (ADR-0064).
 * With no attention signal, fall back to the raw email count:
 * a false send is better than a silent suppression (ADR-0048).
 */
export function isQuietMorning(args: {
  demandingEmailCount: number | undefined;
  emailCount: number;
  activityCount: number;
  meetingCount: number;
}): boolean {
  if (args.activityCount > 0 || args.meetingCount > 0) return false;

  return args.demandingEmailCount !== undefined
    ? args.demandingEmailCount === 0
    : args.emailCount === 0;
}

export interface SurfacedKeys {
  threadIds: Set<string>;
  /** {@link deriveLoopKey} of each item's persisted `subject`. Catches a re-notify on a new thread. */
  loopKeys: Set<string>;
}

/**
 * Threads and loop keys that a recent sent briefing actually cited.
 * Backs `previouslySurfaced`, so the agent does not have to match prose.
 */
async function listRecentlySurfacedKeys(args: {
  userId: string;
  /** Pass the run's frozen "until". */
  before: Date;
  lookbackMs?: number;
}): Promise<SurfacedKeys> {
  const lookbackMs = args.lookbackMs ?? SURFACED_LOOKBACK_MS;
  const since = new Date(args.before.getTime() - lookbackMs);

  const rows = await db()
    .select({ gather: briefings.gather, fullBriefing: briefings.fullBriefing })
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

  return collectSurfacedKeys(rows);
}

/** Every thread id across gathers. Only tests call this. */
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

/** Every loop key across gathers. Only tests call this; production uses {@link collectSurfacedKeys}. */
export function collectSurfacedLoopKeys(gathers: Array<BriefingGather | null>): Set<string> {
  const keys = new Set<string>();

  for (const gather of gathers) {
    const categories = gather?.email.categories;

    if (!categories) continue;

    for (const items of Object.values(categories)) {
      for (const item of items ?? []) {
        const key = deriveLoopKey(item.subject, { sender: item.sender });

        if (key) keys.add(key);
      }
    }
  }

  return keys;
}

export interface SurfacedBriefingPayload {
  gather: BriefingGather | null;
  fullBriefing: FullBriefing | null;
}

/**
 * Continuation keys only for emails the prose cited.
 * An uncited gather candidate must not suppress the next slot.
 */
export function collectSurfacedKeys(rows: ReadonlyArray<SurfacedBriefingPayload>): SurfacedKeys {
  const threadIds = new Set<string>();
  const loopKeys = new Set<string>();

  for (const row of rows) {
    const surfacedDocumentIds = new Set(row.fullBriefing?.surfacedDocumentIds ?? []);

    if (surfacedDocumentIds.size === 0) continue;

    const categories = row.gather?.email.categories;

    if (!categories) continue;

    for (const items of Object.values(categories)) {
      for (const item of items ?? []) {
        if (!surfacedDocumentIds.has(item.documentId)) continue;

        if (item.threadId) threadIds.add(item.threadId);
        const key = deriveLoopKey(item.subject, { sender: item.sender });

        if (key) loopKeys.add(key);
      }
    }
  }

  return { threadIds, loopKeys };
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
      accountId: documents.accountId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, args.documentId),
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (!row) return null;
  const meta = parseGmailDocumentMetadata(row.metadata);

  const suppressionInstructions = await listActiveSuppressionInstructions(args.userId);

  const suppressed = findSenderSuppression(suppressionInstructions, {
    senderEmail: meta.from ?? null,
    accountId: row.accountId,
    effect: "exclude_briefing_priority",
  });

  if (suppressed) return null;

  const full = row.content ?? "";
  const truncated = full.length > READ_EMAIL_BODY_CHAR_CAP;

  return {
    documentId: row.documentId,
    subject: row.subject,
    from: meta.from ?? null,
    authoredAt: row.authoredAt,
    body: truncated ? full.slice(0, READ_EMAIL_BODY_CHAR_CAP) : full,
    truncated,
  };
}

interface ListPriorBriefingsArgs {
  userId: string;
  limit?: number;
  /** Null returns both slots. */
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

/** Null when this slot never reached a terminal state; gather then looks back 24h. */
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
