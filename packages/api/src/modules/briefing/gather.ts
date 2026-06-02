import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import type { BriefingGather, IanaTimezone } from "@alfred/contracts";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, desc, eq, gte, lte } from "drizzle-orm";

/**
 * Inbox-only briefing data shape (ADR-0025 #2).
 *
 * One bucket per priority category. `newsletter`, `marketing`, `fyi`,
 * and `done` are excluded from the priority list — they're either
 * promotional (newsletter, marketing), non-actionable status noise
 * (fyi), or closure notices that don't need user attention (done).
 * Leaving them out is what makes the briefing a *priority* inbox
 * rather than a flat last-24-hours digest.
 *
 * Counts are surfaced separately so the briefing can still mention
 * "+12 newsletters arrived" without expanding them inline.
 *
 * Display order for the priority buckets mirrors the user's own Gmail
 * label numbering (urgent=1, action_needed=2, follow_up=3, …); urgent
 * sits first so a same-day-actionable item never gets buried under a
 * full action_needed list.
 */

const PRIORITY_CATEGORIES = [
  "urgent",
  "action_needed",
  "follow_up",
  "awaiting_reply",
  "meeting",
  "payment",
] as const satisfies readonly TriageCategory[];

const SUPPRESSED_CATEGORIES = [
  "fyi",
  "done",
  "newsletter",
  "marketing",
] as const satisfies readonly TriageCategory[];

export type PriorityCategory = (typeof PRIORITY_CATEGORIES)[number];
export type SuppressedCategory = (typeof SUPPRESSED_CATEGORIES)[number];

const PRIORITY_CATEGORY_SET: ReadonlySet<string> = new Set(PRIORITY_CATEGORIES);
const SUPPRESSED_CATEGORY_SET: ReadonlySet<string> = new Set(SUPPRESSED_CATEGORIES);

export interface BriefingItem {
  documentId: string;
  category: PriorityCategory;
  confidence: number;
  rationale: string | null;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  authoredAt: Date | null;
  /** Stable Gmail webview URL when we have the source thread id. */
  threadUrl: string | null;
}

export interface BriefingDigest {
  windowStart: Date;
  windowEnd: Date;
  /** One entry per priority category, in display order. Empty arrays are kept (renders as "nothing here"). */
  buckets: Record<PriorityCategory, BriefingItem[]>;
  /** Last-24h counts for the suppressed categories — surfaced as a tail line. */
  suppressedCounts: Record<SuppressedCategory, number>;
  totalPriority: number;
  totalSuppressed: number;
}

export interface GatherBriefingDigestArgs {
  userId: string;
  /** Defaults to 24h before `windowEnd`. */
  windowStart?: Date;
  /** Defaults to "now". */
  windowEnd?: Date;
  /** Cap per bucket — protects the email body length on busy days. */
  maxPerBucket?: number;
}

export interface GatherBriefingArgs {
  userId: string;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: string;
  timezone: IanaTimezone;
  windowStart?: Date;
  windowEnd?: Date;
}

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_PER_BUCKET = 8;

/**
 * Pull a user's last-24h triaged email into briefing-shaped buckets.
 * Pure read against `email_triage` joined to `documents`; no Gmail API
 * call required (the triage workflow already wrote the categorisations).
 */
export async function gatherBriefingDigest(
  args: GatherBriefingDigestArgs,
): Promise<BriefingDigest> {
  const windowEnd = args.windowEnd ?? new Date();
  const windowStart =
    args.windowStart ?? new Date(windowEnd.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);
  const maxPerBucket = args.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;

  // One query gets every triaged document in window — we partition into
  // buckets in JS afterwards. At single-user scale (a few hundred emails
  // a day, max), the JS partition is faster than 6 separate queries.
  const rows = await db()
    .select({
      // Select from the documents side of the inner-join — `emailTriage.documentId`
      // is nullable in the thread-keyed schema (pointer can dangle after a doc
      // purge); the joined `documents.id` is guaranteed non-null here.
      documentId: documents.id,
      category: emailTriage.category,
      confidence: emailTriage.confidence,
      rationale: emailTriage.rationale,
      title: documents.title,
      authoredAt: documents.authoredAt,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
      ingestedAt: documents.ingestedAt,
    })
    .from(emailTriage)
    .innerJoin(documents, eq(emailTriage.documentId, documents.id))
    .where(
      and(
        eq(emailTriage.userId, args.userId),
        // Use ingestedAt as the window pivot — `documents.authoredAt` can
        // be days old if a thread surfaces a backfilled message; what
        // matters for "today's briefing" is what alfred saw today.
        gte(documents.ingestedAt, windowStart),
        lte(documents.ingestedAt, windowEnd),
      ),
    )
    .orderBy(desc(documents.authoredAt));

  const buckets: Record<PriorityCategory, BriefingItem[]> = {
    urgent: [],
    action_needed: [],
    follow_up: [],
    awaiting_reply: [],
    meeting: [],
    payment: [],
  };
  const suppressedCounts: Record<SuppressedCategory, number> = {
    fyi: 0,
    done: 0,
    newsletter: 0,
    marketing: 0,
  };

  for (const r of rows) {
    const cat = r.category;

    if (isSuppressed(cat)) {
      suppressedCounts[cat] += 1;
      continue;
    }
    if (!isPriority(cat)) continue;

    const bucket = buckets[cat];
    if (bucket.length >= maxPerBucket) continue;

    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    bucket.push({
      documentId: r.documentId,
      category: cat,
      confidence: r.confidence,
      rationale: r.rationale,
      subject: r.title,
      from: typeof meta.from === "string" ? meta.from : null,
      snippet: typeof meta.snippet === "string" ? meta.snippet : null,
      authoredAt: r.authoredAt,
      threadUrl: r.sourceThreadId ? gmailThreadUrl(r.sourceThreadId) : null,
    });
  }

  const totalPriority = PRIORITY_CATEGORIES.reduce((sum, category) => {
    return sum + buckets[category].length;
  }, 0);
  const totalSuppressed = Object.values(suppressedCounts).reduce((sum, n) => sum + n, 0);

  return {
    windowStart,
    windowEnd,
    buckets,
    suppressedCounts,
    totalPriority,
    totalSuppressed,
  };
}

export async function gatherBriefing(args: GatherBriefingArgs): Promise<BriefingGather> {
  const windowEnd = args.windowEnd ?? localEndOfDay(args.briefingDate, args.timezone);
  const digest = await gatherBriefingDigest({
    userId: args.userId,
    windowStart: args.windowStart,
    windowEnd,
  });
  const categories: BriefingGather["email"]["categories"] = {};
  for (const category of PRIORITY_CATEGORIES) {
    categories[category] = digest.buckets[category].map((item) => ({
      documentId: item.documentId,
      threadId: threadIdFromGmailUrl(item.threadUrl),
      subject: item.subject?.trim() || "(no subject)",
      sender: shortenFrom(item.from) ?? "Unknown sender",
      snippet: item.snippet ?? item.rationale ?? "",
    }));
  }

  return {
    email: {
      categories,
    },
    calendar: null,
    integration_activity: { items: [] },
    weather: null,
    day_of_week: dayContribution(args.briefingDate, args.timezone),
  };
}

function isPriority(c: string): c is PriorityCategory {
  return PRIORITY_CATEGORY_SET.has(c);
}

function isSuppressed(c: string): c is SuppressedCategory {
  return SUPPRESSED_CATEGORY_SET.has(c);
}

/**
 * Best-effort Gmail webview URL. Gmail accepts thread ids in the `#all/`
 * path; this gets the user one click away from the thread without
 * requiring us to know which authenticated account they're viewing
 * (Gmail picks the active account itself).
 */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function threadIdFromGmailUrl(url: string | null): string {
  if (!url) return "";
  const tail = url.slice(url.lastIndexOf("/") + 1);
  return decodeURIComponent(tail);
}

function dayContribution(
  briefingDate: string,
  timezone: IanaTimezone,
): BriefingGather["day_of_week"] {
  const date = new Date(`${briefingDate}T12:00:00Z`);
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(date);
  return {
    dayName,
    isWeekend: dayName === "Saturday" || dayName === "Sunday",
  };
}

function localEndOfDay(briefingDate: string, timezone: IanaTimezone): Date {
  return localStartOfDay(addLocalDays(briefingDate, 1), timezone);
}

function localStartOfDay(localDate: string, timezone: IanaTimezone): Date {
  let candidate = new Date(`${localDate}T00:00:00.000Z`);
  for (let i = 0; i < 3; i += 1) {
    candidate = new Date(Date.UTC(...dateParts(localDate)) - timezoneOffsetMs(candidate, timezone));
  }
  return candidate;
}

function timezoneOffsetMs(at: Date, timezone: IanaTimezone): number {
  const value =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(value);
  if (!match?.groups?.sign) return 0;

  const sign = match.groups.sign === "-" ? -1 : 1;
  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes ?? "0");
  return sign * (hours * 60 + minutes) * 60_000;
}

function addLocalDays(localDate: string, days: number): string {
  const next = new Date(Date.UTC(...dateParts(localDate), 12));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function dateParts(localDate: string): [number, number, number] {
  const [year, month, day] = localDate.split("-").map(Number);
  return [year ?? 0, (month ?? 1) - 1, day ?? 1];
}

function shortenFrom(from: string | null): string | null {
  if (!from) return null;
  const trimmed = from.trim();
  const angleMatch = trimmed.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1]?.trim();
    if (name) return name;
    return angleMatch[2] ?? null;
  }
  return trimmed;
}

export { PRIORITY_CATEGORIES, SUPPRESSED_CATEGORIES };
