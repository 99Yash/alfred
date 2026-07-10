import {
  deriveLoopKey,
  isTriageCategory,
  parseEmailAddress,
  scoreAttentionForItems,
  toMessage,
  toRecord,
  toStringArray,
} from "@alfred/contracts";
import type {
  AttentionBand,
  BriefingGather,
  BriefingSlot,
  FullBriefing,
  SignificanceBand,
  TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings, documents, emailTriage, type Briefing } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getSenderSignificanceBatch } from "../memory/significance";
import {
  findSenderSuppression,
  listActiveSuppressionInstructions,
} from "../memory/standing-instructions";
import { formatInstantInTimezone } from "../timezone";

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
/** Metadata-only page size while skipping standing-instruction-suppressed senders. */
const EMAIL_LIST_SUPPRESSION_PAGE_SIZE = 200;
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
  /**
   * The email's receipt time rendered as wall-clock in the user's timezone
   * (e.g. "Fri, Jun 26, 3:10 AM") — the signal the agent phrases from (#284).
   * Sourced from Gmail `internalDate`, not the sender-controlled RFC `Date`
   * header. Null when the caller passes no timezone or the Gmail receipt
   * timestamp is unavailable — the agent should then not assert a receipt time.
   */
  receivedAtLocal: string | null;
  /**
   * Gmail read-state derived from the message's `UNREAD` label (#284):
   * `true` = still unread, `false` = the user has opened it (label removed),
   * `null` = no label signal captured, so read-state is unknown. The agent
   * must NOT assume unseen: soften a `false` item from a fresh ask toward
   * "for reference," and never assert the user has/hasn't seen a `null` one.
   */
  unread: boolean | null;
  threadId: string | null;
  /**
   * True when this email's underlying *loop* already went out in a recent
   * terminal briefing (within {@link SURFACED_LOOKBACK_MS}). "Loop" is broader
   * than the Gmail thread: a match on either the thread id **or** a stable
   * loop/entity key ({@link deriveLoopKey}) counts, so a collaboration tool
   * re-notifying about the same task/PR on a *new* thread is still recognized
   * as a continuation (#283). The agent should close the loop on it ("still no
   * reply") or drop it, never re-introduce it as fresh — that morning/evening
   * duplication is what erodes trust. Computed deterministically from prior
   * briefings' persisted `gather`, not from LLM prose-matching.
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
  /**
   * User's IANA timezone — used to render each item's `receivedAtLocal`. Omit
   * (e.g. in DB-only tests) and `receivedAtLocal` stays null.
   */
  timezone?: string;
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
    // Anchor the lookback on the run's frozen "until" instant so the signal is
    // deterministic with the rest of the window, not wall-clock at map time.
    listRecentlySurfacedKeys({ userId: args.userId, before: args.untilIngestedAt }),
    // Standing instructions that exclude a sender from briefing priority. The
    // briefing AGENT composes from THIS list, so the suppression must be applied
    // here too — `gather` filters its own deterministic payload, but the prose
    // is written off `list_emails_since`, and without this a suppressed sender
    // (e.g. one the user just told Alfred to stop surfacing) leaks straight back
    // into the headline.
    listActiveSuppressionInstructions(args.userId, "exclude_briefing_priority"),
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

    // Drop suppressed senders before scoring so they neither surface nor skew
    // the cross-row recurrence signal. Mirrors the same filter in `gather`.
    for (const row of page) {
      if (hasSuppression) {
        const from = toRecord(row.metadata).from;
        const suppressed = findSenderSuppression(suppressionInstructions, {
          senderEmail: typeof from === "string" ? from : null,
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
    // A recent briefing may have surfaced this same loop under a *different*
    // Gmail thread (a collaboration tool re-notifying about the same task/PR on
    // a fresh thread — #283), so match on either the thread id or the loop key.
    const loopKey = deriveLoopKey(r.subject, { sender: senders[i] ?? null });
    const surfacedByThread = r.sourceThreadId ? surfaced.threadIds.has(r.sourceThreadId) : false;
    const surfacedByLoop = loopKey ? surfaced.loopKeys.has(loopKey) : false;
    const receiptInstant = gmailReceivedAt(r.gmailInternalDate);
    return {
      documentId: r.documentId,
      subject: r.subject,
      from: senders[i] ?? null,
      snippet: typeof meta.snippet === "string" ? meta.snippet : null,
      triageCategory: r.triageCategory,
      triageRationale: r.triageRationale,
      authoredAt: r.authoredAt,
      ingestedAt: r.ingestedAt,
      receivedAtLocal: args.timezone
        ? formatInstantInTimezone(receiptInstant, args.timezone)
        : null,
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

/** A triage category string narrowed to the contract enum, or null if unknown/absent. */
function toTriageCategory(category: string | null): TriageCategory | null {
  return isTriageCategory(category) ? category : null;
}

/**
 * Gmail read-state from a document's stored `labelIds` (#284). The ingestor
 * persists `metadata.labelIds` on every Gmail row; a message carries the
 * `UNREAD` label until it is opened. An absent/non-array value means no label
 * signal was captured (older rows, non-Gmail) → `null` (unknown), so the agent
 * neither asserts seen nor unseen. A present empty array is a captured "not
 * unread" state, matching the inbox reader.
 */
function unreadFromLabels(labelIds: unknown): boolean | null {
  if (!Array.isArray(labelIds)) return null;
  return toStringArray(labelIds).includes("UNREAD");
}

/**
 * Real Gmail receipt time, not the RFC `Date` header. Gmail's `internalDate`
 * is the inbox-ordering timestamp and, for normal SMTP mail, the instant Google
 * accepted the message. The query reads metadata going forward and falls back
 * to `raw.internalDate` so already-ingested rows get the same semantics. If
 * neither exists, return null rather than pretending `authoredAt` or
 * `ingestedAt` is a receipt timestamp.
 */
function gmailReceivedAt(internalDate: string | null): Date | null {
  if (!internalDate) return null;
  const epochMs = Number(internalDate);
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date;
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

/** One already-gathered priority email, reduced to the scorer's inputs. */
export interface PriorityEmailDemandItem {
  /** Raw `From` (display-name + address ok) — used for bulk + significance lookup. */
  sender: string | null;
  subject: string | null;
  /** Short body/header context for category-specific pins such as payment failures. */
  snippet?: string | null;
  /** The honest, immutable triage category — the demand floor. */
  category: TriageCategory;
  /** Chronological key for recurrence (e.g. `authoredAt`); null falls back to input order. */
  occurredAtMs: number | null;
}

export interface PriorityEmailDemand {
  /** How many of the gathered priority emails scored at the `demanding` band. */
  demandingCount: number;
  /** Highest band across the set — `muted` when the set is empty. */
  topBand: AttentionBand;
}

/**
 * Score an already-gathered set of priority emails for the morning suppression
 * gate (#259 / ADR-0064). Uses the SAME windowed scorer + significance read the
 * agent's `list_emails_since` uses, so the deterministic send/suppress decision
 * and the agent's own ranking agree on what "demanding" means — the gate never
 * suppresses a day the agent would have led with, and never composes a day whose
 * only items the agent would drop.
 *
 * Recurrence is a cross-row property, so pass the WHOLE window's priority items
 * in one call (a machine notification fired ten times decays out of the
 * demanding lane here exactly as it does for the agent). Significance is
 * best-effort: an unscored / non-human sender degrades to the category floor.
 * Quiet `payment`/`follow_up` items stay below `demanding`, but payment items
 * that look failed/due/actionable are pinned demanding so we do not silently eat
 * a real billing problem. An unscored `awaiting_reply`/`action_needed` also
 * sends — ADR-0048's morning posture. A significance-read failure degrades the
 * whole set to intrinsic-only rather than failing the gather.
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
    // Never fail the whole briefing over a significance read — fall back to
    // intrinsic-only scoring (today's Phase-A behavior).
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
 * Morning suppression predicate (#259 / ADR-0064). A cron morning is "quiet" —
 * suppressing without an LLM call — when nothing in the window demands the user:
 * no priority email at the `demanding` attention band, no integration activity,
 * and no calendar events. `demandingEmailCount` is the attention-aware
 * replacement for the old raw priority-email count — a normal/muted item (a
 * resolved micro-charge, a cold ask, a bot digest once significance demotes it)
 * no longer forces a send and promotes itself to the headline. Pure so the
 * suppression invariant is unit-pinned.
 *
 * When the attention signal is unavailable (`demandingEmailCount` undefined —
 * a legacy gather or a failed day-shape), fall back to the raw email count so a
 * signalless day still sends if anything landed: erring toward sending is
 * ADR-0048's morning posture, and the wrong direction to fail is a silent
 * suppression that eats a real briefing.
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

/** Both continuation signals a recent briefing left behind for the next slot. */
export interface SurfacedKeys {
  /** Gmail thread ids surfaced in a recent terminal briefing. */
  threadIds: Set<string>;
  /**
   * Stable loop/entity keys ({@link deriveLoopKey}) of those items — the signal
   * that recognizes a re-notification of the same task/PR on a *new* thread
   * (#283). Derived from each item's persisted `subject`, so it lines up with
   * the current-window derivation in {@link listEmailsSinceWatermark}.
   */
  loopKeys: Set<string>;
}

/**
 * The thread ids **and** loop keys actually surfaced in a recent terminal
 * briefing — the sets the next slot should treat as continuations, not fresh
 * items. Sourced from the delivered briefing's persisted
 * `fullBriefing.surfacedDocumentIds`, then resolved back through
 * `gather.email.categories[*][]`. This is the deterministic backbone of the
 * `previouslySurfaced` flag on {@link EmailListItem}; it replaces relying on
 * the agent to fuzzy-match prose across `list_prior_briefings`.
 */
export async function listRecentlySurfacedKeys(args: {
  userId: string;
  /** Upper bound the lookback window subtracts from — pass the run's frozen "until". */
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

/**
 * Pure extraction of every thread id referenced across a set of gather
 * payloads. Split out from {@link listRecentlySurfacedKeys} so the dedup
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

/**
 * Pure extraction of every loop/entity key across a set of gather payloads.
 * Legacy helper kept for narrow unit coverage; the production continuation
 * signal uses {@link collectSurfacedKeys}, which filters to actual cited docs.
 */
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
 * Extract continuation signals only for email documents the delivered prose
 * actually cited. Gather can hold many priority candidates the model chose to
 * omit; those must not become "already told you" suppressors for the next slot.
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
  const meta = toRecord(row.metadata);
  const suppressionInstructions = await listActiveSuppressionInstructions(
    args.userId,
    "exclude_briefing_priority",
  );
  const suppressed = findSenderSuppression(suppressionInstructions, {
    senderEmail: typeof meta.from === "string" ? meta.from : null,
    accountId: row.accountId,
    effect: "exclude_briefing_priority",
  });
  if (suppressed) return null;

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
