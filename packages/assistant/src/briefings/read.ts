import {
  deriveLoopKey,
  isSentGmailMetadata,
  isTriageCategory,
  parseGmailDocumentMetadata,
  scoreAttentionForItems,
} from "@alfred/contracts";
import type {
  AttentionBand,
  BriefingGather,
  BriefingSlot,
  FullBriefing,
  GmailDocumentMetadata,
  IanaTimezone,
  TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings, documents, emailTriage, type Briefing } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { describeCorrespondentHistory, loadMailFacts, type MailFacts } from "../knowledge";
import { TRIAGE_OUT_OF_SCOPE_MEANING, triageOutOfScope } from "@alfred/assistant/triage";
import { inZone } from "@alfred/assistant/time";
import type { ActivityWindow } from "@alfred/assistant/connections";
import { officialWarningsFallback } from "./provenance";

/**
 * Read helpers for the daily briefing.
 * Each run for `(user_id, slot)` reads documents ingested after the last
 * sent or suppressed `watermark_at`. Composed and failed rows are reprocessed.
 */

const PRIOR_BRIEFINGS_DEFAULT_LIMIT = 5;

const EMAIL_LIST_DEFAULT_LIMIT = 60;

const READ_EMAIL_BODY_CHAR_CAP = 8_000;

/** 16h covers both morning to evening (~10h) and last night to morning (~12h). */
const SURFACED_LOOKBACK_MS = 16 * 60 * 60 * 1000;

const SURFACED_LOOKBACK_LIMIT = 4;

/** Each `outsideTriage` value and what it means. The composer prompt and tool read this table. */
const OUTSIDE_TRIAGE_MEANING = {
  ...TRIAGE_OUT_OF_SCOPE_MEANING,
  sent_by_you: "it is the user's own sent mail",
} as const;

/** The `outsideTriage` values with their meanings, as one line for the composer. */
export const OUTSIDE_TRIAGE_VALUES = Object.entries(OUTSIDE_TRIAGE_MEANING)
  .map(([value, meaning]) => `\`${value}\` (${meaning})`)
  .join(", ");

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
  /** The sender's mail history line (ADR-0127). Null on a read failure. */
  correspondentHistory: string | null;
  /** Lets the agent decide if a `read_email` call is worth it. */
  contentLength: number;
  /**
   * Where the mail sits when triage does not label it (`triageOutOfScope`), or `sent_by_you` for
   * the user's own sent mail. Null: the mail is in the inbox scope that triage labels.
   */
  outsideTriage: keyof typeof OUTSIDE_TRIAGE_MEANING | null;
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
  /**
   * The `before` of the previous page: the document id of its oldest row in the read order.
   * Omit it to read the newest page. Check it with `emailCursorInWindow` first: a cursor that
   * names no row of the window gives an empty page, which reads like the end of the list.
   */
  before?: string;
}

/**
 * One page of the window, newest first by arrival. The composer pages with `before`, so newer
 * noise cannot hide an older mail that asks for something: no code filters the window by an
 * instruction since triage slice 4a.
 */
export interface EmailListPage {
  items: EmailListItem[];
  /** The cursor of the next older page, or null when this page holds the oldest mail of the window. */
  before: string | null;
}

interface EmailListRow {
  documentId: string;
  subject: string | null;
  authoredAt: Date | null;
  ingestedAt: Date;
  sourceThreadId: string | null;
  metadata: unknown;
  gmailInternalDate: string | null;
  contentLength: number;
  triageCategory: TriageCategory | null;
  triageRationale: string | null;
}

/** The Gmail documents of the briefing window: after `since`, up to and with `until`. */
function emailWindowConditions(
  args: Pick<ListEmailsSinceArgs, "userId" | "sinceIngestedAt" | "untilIngestedAt">,
): SQL[] {
  const conditions = [
    eq(documents.userId, args.userId),
    eq(documents.source, "gmail"),
    sql`${documents.ingestedAt} <= ${args.untilIngestedAt}`,
  ];

  if (args.sinceIngestedAt) {
    conditions.push(gt(documents.ingestedAt, args.sinceIngestedAt));
  }

  return conditions;
}

/**
 * The rows after the cursor row in the read order (`ingested_at` desc, then `id` desc). Postgres
 * reads the time of the cursor row, so the compare keeps the microseconds that a `Date` loses.
 */
function olderThanEmail(userId: string, before: string): SQL {
  const cursor = alias(documents, "email_cursor");

  const cursorRow = db()
    .select({ ingestedAt: cursor.ingestedAt, id: cursor.id })
    .from(cursor)
    .where(and(eq(cursor.id, before), eq(cursor.userId, userId)));

  return sql`(${documents.ingestedAt}, ${documents.id}) < ${cursorRow}`;
}

/** True when `before` names a Gmail document of the window, so the page after it is real. */
export async function emailCursorInWindow(
  args: Pick<ListEmailsSinceArgs, "userId" | "sinceIngestedAt" | "untilIngestedAt"> & {
    before: string;
  },
): Promise<boolean> {
  const rows = await db()
    .select({ id: documents.id })
    .from(documents)
    .where(and(...emailWindowConditions(args), eq(documents.id, args.before)))
    .limit(1);

  return rows.length > 0;
}

export async function listEmailsSinceWatermark(args: ListEmailsSinceArgs): Promise<EmailListPage> {
  const limit = args.limit ?? EMAIL_LIST_DEFAULT_LIMIT;
  const conditions = emailWindowConditions(args);

  if (args.before !== undefined) conditions.push(olderThanEmail(args.userId, args.before));

  // Anchor on the frozen "until" so the signal does not depend on wall-clock time.
  const surfaced = await listRecentlySurfacedKeys({
    userId: args.userId,
    before: args.untilIngestedAt,
  });

  // The stored label of each mail. No code applies a standing instruction since triage slice 4a;
  // the composer reads the instructions in words. One extra row tells whether an older page exists.
  const fetched: EmailListRow[] = await db()
    .select({
      documentId: documents.id,
      subject: documents.title,
      authoredAt: documents.authoredAt,
      ingestedAt: documents.ingestedAt,
      sourceThreadId: documents.sourceThreadId,
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
    .limit(limit + 1);

  const rows = fetched.slice(0, limit);
  const before = fetched.length > limit ? (rows.at(-1)?.documentId ?? null) : null;

  const metas = rows.map((r) => parseGmailDocumentMetadata(r.metadata));
  const senders = metas.map((meta) => meta.from ?? null);

  // The scope reads the mail facts, as the classify step does, so both agree on each mail.
  const mailFacts = await loadMailFacts(
    args.userId,
    rows.map((r) => r.documentId),
  );

  // Score the page together: recurrence is cross-row, so a repeat split across two pages
  // counts only within each page. Untriaged rows stay `normal`.
  // No significance input: the band is recurrence only (ADR-0127).
  const attention = scoreAttentionForItems(
    rows.map((r, i) => ({
      sender: senders[i],
      subject: r.subject,
      category: toTriageCategory(r.triageCategory) ?? "fyi",
      // Rows arrive newest-first.
      occurredAtMs: (r.authoredAt ?? r.ingestedAt).getTime(),
    })),
  );

  const items = rows.map((r, i) => {
    const meta = metas[i];
    // Match on thread id or loop key: a tool can re-notify on a new thread.
    const loopKey = deriveLoopKey(r.subject, { sender: senders[i] ?? null });
    const surfacedByThread = r.sourceThreadId ? surfaced.threadIds.has(r.sourceThreadId) : false;
    const surfacedByLoop = loopKey ? surfaced.loopKeys.has(loopKey) : false;
    const receiptInstant = gmailReceivedAt(r.gmailInternalDate);
    const facts = mailFacts.get(r.documentId);
    const history = facts?.sender.history;

    return {
      documentId: r.documentId,
      subject: r.subject,
      from: senders[i] ?? null,
      snippet: meta?.snippet ?? null,
      triageCategory: r.triageCategory,
      triageRationale: r.triageRationale,
      authoredAt: r.authoredAt,
      ingestedAt: r.ingestedAt,
      receivedAtLocal:
        args.timezone && receiptInstant ? inZone(args.timezone).format(receiptInstant) : null,
      unread: unreadFromLabels(meta?.labelIds),
      threadId: r.sourceThreadId,
      previouslySurfaced: surfacedByThread || surfacedByLoop,
      attentionBand: toTriageCategory(r.triageCategory)
        ? (attention[i]?.band ?? "normal")
        : "normal",
      contentLength: Number(r.contentLength),
      // One history line for the sender address (ADR-0127); null on a read failure.
      correspondentHistory:
        history && facts.arrivedAt
          ? describeCorrespondentHistory(history, facts.arrivedAt.timezone)
          : null,
      outsideTriage: outsideTriageOf(meta, facts),
    } satisfies EmailListItem;
  });

  // The window picks by the received time; the page reads in sent order, newest first
  // (stores.md § Time). A row with no sent time sorts by its received time. The cursor stays the
  // oldest row by arrival, so the next page starts where this one ended.
  return {
    items: items.toSorted(
      (a, b) => (b.authoredAt ?? b.ingestedAt).getTime() - (a.authoredAt ?? a.ingestedAt).getTime(),
    ),
    before,
  };
}

function outsideTriageOf(
  meta: GmailDocumentMetadata | undefined,
  facts: MailFacts | undefined,
): EmailListItem["outsideTriage"] {
  if (meta && isSentGmailMetadata(meta)) return "sent_by_you";

  return facts ? triageOutOfScope(facts) : null;
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
 * Failed or due payments pin to demanding. No significance read: category and recurrence decide.
 */
export function scorePriorityEmailDemand(
  items: readonly PriorityEmailDemandItem[],
): PriorityEmailDemand {
  if (items.length === 0) return { demandingCount: 0, topBand: "muted" };

  const scored = scoreAttentionForItems(
    items.map((item) => ({
      sender: item.sender,
      subject: item.subject,
      category: item.category,
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
  if (item.category !== "receipt") return false;
  const text = [item.subject, item.snippet].filter(Boolean).join("\n");

  return ACTIONABLE_PAYMENT_RE.test(text);
}

/**
 * Morning is quiet, and suppresses without an LLM call, when nothing is demanding,
 * there is no integration activity, and no meetings (ADR-0064).
 * `githubMergedTotal` counts merges the live GitHub read proved that no webhook delivered,
 * so a merge day is not quiet (ADR-0062 amendment 2026-10-27). A broken connection the user
 * can repair is not quiet either: the block must reach the user each day the break lasts
 * (ADR-0100 amendment 2026-10-28). An official warning for the user's place ranks first under
 * "at risk", so it is not quiet either (ADR-0117 decision 4). A warning for the time-zone default
 * city does not count: `sendableOfficialWarningCount` gives the count. An activity source that the
 * gather could not see is not quiet either (ADR-0118 decision 4): a suppressed morning moves the
 * watermark past its acts, and they reach no briefing. The briefing goes out and names the gap.
 * With no attention signal, fall back to the raw email count: a false send is better than a silent
 * suppression (ADR-0048).
 */
export function isQuietMorning(args: {
  demandingEmailCount: number | undefined;
  emailCount: number;
  activityCount: number;
  /** Merges the live GitHub read counted. Absent when the read failed or was not run. */
  githubMergedTotal?: number | undefined;
  meetingCount: number;
  /** Rows of the briefing's fixed broken-connection block. */
  brokenConnectionCount: number;
  /**
   * Activity sources that the gather could not see and that are not block rows:
   * `activityGapCountWithoutRow`. A block row counts in `brokenConnectionCount`.
   */
  activityGapCount: number;
  /** Official warnings that may send a morning: `sendableOfficialWarningCount`. */
  officialWarningCount: number;
}): boolean {
  if (
    args.officialWarningCount > 0 ||
    args.activityCount > 0 ||
    args.meetingCount > 0 ||
    (args.githubMergedTotal ?? 0) > 0 ||
    args.brokenConnectionCount > 0 ||
    args.activityGapCount > 0
  ) {
    return false;
  }

  return args.demandingEmailCount !== undefined
    ? args.demandingEmailCount === 0
    : args.emailCount === 0;
}

/** Counts for the send gates. The daily workflow reads `email` only as the fallback for `demandingEmailCount` (#259); legacy `decideSend` reads it as a send signal. */
export interface GatheredCounts {
  email: number;
  activity: number;
  meetings: number;
  /**
   * Official warnings that the gather selected, for the place that it read. The gather logs read
   * it. The send gates read `sendableOfficialWarningCount`, because a default-city warning does not send.
   */
  officialWarnings: number;
}

export function gatherCounts(gather: BriefingGather): GatheredCounts {
  return {
    email: Object.values(gather.email.categories).reduce((sum, items) => sum + items.length, 0),
    activity: gather.integration_activity.items.length,
    meetings: gather.calendar?.events.length ?? 0,
    officialWarnings: gather.official_warnings?.items.length ?? 0,
  };
}

/**
 * How many official warnings may send a quiet morning. Both send gates read it: `isQuietMorning`
 * and the legacy `decideSend`. A warning for the time-zone default city (a warnings `fallback`)
 * counts 0, because a `fallback` does not send a morning (ADR-0117). The briefing still shows it
 * when the morning sends for another reason. A warning for the user's place counts.
 */
export function sendableOfficialWarningCount(
  gather: Pick<BriefingGather, "official_warnings" | "provenance">,
): number {
  if (officialWarningsFallback(gather.provenance) !== undefined) return 0;

  return gather.official_warnings?.items.length ?? 0;
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
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- briefings.gather is jsonb.$type<BriefingGather>() read here without a parse; an old row can predate the shape.
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
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- briefings.gather is jsonb.$type<BriefingGather>() read here without a parse; an old row can predate the shape.
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
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- briefings.gather is jsonb.$type<BriefingGather>() read here without a parse; an old row can predate the shape.
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

  const full = row.content;
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

/**
 * The window end of the last sent or suppressed briefing of `slot`. `any` reads the last briefing
 * of all slots (the activity window). Null when no such briefing exists; the caller then looks back
 * one day.
 */
export async function fetchLatestWatermark(args: {
  userId: string;
  slot: BriefingSlot | "any";
}): Promise<Date | null> {
  const conditions = [
    eq(briefings.userId, args.userId),
    inArray(briefings.status, ["sent", "suppressed"]),
    isNotNull(briefings.watermarkAt),
  ];

  if (args.slot !== "any") conditions.push(eq(briefings.slot, args.slot));

  const rows = await db()
    .select({ watermarkAt: briefings.watermarkAt })
    .from(briefings)
    .where(and(...conditions))
    .orderBy(desc(briefings.watermarkAt))
    .limit(1);

  return rows[0]?.watermarkAt ?? null;
}

/** The activity window of a first briefing, when no briefing of any slot has a watermark. */
const FIRST_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The most time that one activity window holds. After a long stop of the briefings, the window
 * starts this far back, not at the last watermark: an act older than one week is not news, and the
 * coverage check reduces every delivery of the window.
 */
const MAX_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The activity window of a briefing, and the watermark that the window cap moved past. */
export interface BriefingActivityWindow extends ActivityWindow {
  /**
   * The watermark of the last briefing when it is older than `MAX_ACTIVITY_WINDOW_MS`, so the
   * window starts later than it. Alfred does not read the acts before `start`. `null` when the
   * window starts at the watermark, or when no briefing has a watermark (a first briefing reads one
   * day by design).
   */
  readonly clippedFrom: Date | null;
}

/**
 * The window of the activity record for a briefing that ends at `end`. It starts at the watermark
 * of the last sent or suppressed briefing of any slot, so no act is in two windows: an act is in
 * the morning or the evening window, not both. The email window starts at the last briefing of the same slot
 * (ADR-0048 decision A) and is not changed here.
 *
 * A missed slot does not move the watermark, so the next briefing reads back to the last briefing
 * that the user got, but not more than `MAX_ACTIVITY_WINDOW_MS`. `clippedFrom` records that cut,
 * and the gather states it to the composer (`activityWindowProvenance`). The gather computes this
 * window one time and the run state keeps its start, so the composer tools read the same window.
 */
export async function readBriefingActivityWindow(args: {
  userId: string;
  end: Date;
}): Promise<BriefingActivityWindow> {
  const since = await fetchLatestWatermark({ userId: args.userId, slot: "any" });
  const end = args.end.getTime();
  const earliest = end - MAX_ACTIVITY_WINDOW_MS;

  if (since === null) {
    return { start: new Date(end - FIRST_ACTIVITY_WINDOW_MS), end: args.end, clippedFrom: null };
  }

  return since.getTime() < earliest
    ? { start: new Date(earliest), end: args.end, clippedFrom: since }
    : { start: since, end: args.end, clippedFrom: null };
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
