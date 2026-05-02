import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, desc, eq, gte } from "drizzle-orm";

/**
 * Inbox-only briefing data shape (ADR-0025 #2).
 *
 * One bucket per priority category. `newsletter` and `fyi` are excluded
 * from the priority list — they're either promotional (newsletter) or
 * non-actionable status noise (fyi); leaving them out is what makes the
 * briefing a *priority* inbox rather than a flat last-24-hours digest.
 *
 * Counts are surfaced separately so the briefing can still mention
 * "+12 newsletters arrived" without expanding them inline.
 */

const PRIORITY_CATEGORIES = [
  "action_needed",
  "awaiting_reply",
  "meeting",
  "payment",
] as const satisfies readonly TriageCategory[];

const SUPPRESSED_CATEGORIES = [
  "newsletter",
  "fyi",
] as const satisfies readonly TriageCategory[];

export type PriorityCategory = (typeof PRIORITY_CATEGORIES)[number];
export type SuppressedCategory = (typeof SUPPRESSED_CATEGORIES)[number];

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
      documentId: emailTriage.documentId,
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
      ),
    )
    .orderBy(desc(documents.authoredAt));

  const buckets: Record<PriorityCategory, BriefingItem[]> = {
    action_needed: [],
    awaiting_reply: [],
    meeting: [],
    payment: [],
  };
  const suppressedCounts: Record<SuppressedCategory, number> = {
    newsletter: 0,
    fyi: 0,
  };

  for (const r of rows) {
    if (r.authoredAt && r.authoredAt > windowEnd) continue;
    const cat = r.category as TriageCategory;

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

  const totalPriority = (Object.values(buckets) as BriefingItem[][]).reduce(
    (sum, b) => sum + b.length,
    0,
  );
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

function isPriority(c: TriageCategory): c is PriorityCategory {
  return (PRIORITY_CATEGORIES as readonly string[]).includes(c);
}

function isSuppressed(c: TriageCategory): c is SuppressedCategory {
  return (SUPPRESSED_CATEGORIES as readonly string[]).includes(c);
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

export { PRIORITY_CATEGORIES, SUPPRESSED_CATEGORIES };
