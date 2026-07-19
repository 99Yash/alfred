import type {
  BriefingGather,
  BriefingSlot,
  CalendarContribution,
  DayShape,
  IanaTimezone,
  IntegrationActivityItem,
  StateCategory,
  WeatherContribution,
  WeatherFallbackLocation,
} from "@alfred/contracts";
import {
  isLoopClosingCategory,
  isRecord,
  toMessage,
  toRecord,
  toStringArray,
  weatherFallbackFor,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials, webhookEvents } from "@alfred/db/schemas";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  type CalendarEvent,
  getFreshAccessToken,
  listEvents,
  type TriageCategory,
} from "@alfred/integrations/google";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  extractGithubKeys,
  isGithubNotificationSender,
  type ObjectState,
  objectStateStore,
} from "../integrations/object-state";
import { getPreference } from "../memory/preferences";
import {
  findSenderSuppression,
  listActiveSuppressionInstructions,
} from "../memory/standing-instructions";
import { addLocalDays, localStartOfDay } from "../timezone";
import { scorePriorityEmailDemand } from "./read";
import { shortenFrom } from "./sender";

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
  /** Priority items dropped because a standing instruction matched the sender. */
  suppressedByInstruction: BriefingInstructionSuppression[];
  /**
   * Priority items dropped because object-state (ADR-0062) shows the underlying
   * work object has reached a terminal state — e.g. a CI-failure email whose PR
   * has since merged. These feed the evening "closed today" recap (ADR-0048 #5).
   */
  closedLoops: BriefingClosedLoop[];
  totalPriority: number;
  totalSuppressed: number;
}

export interface BriefingInstructionSuppression {
  documentId: string;
  category: PriorityCategory;
  sender: string | null;
  factId: string;
  effect: "exclude_briefing_priority";
}

export interface BriefingClosedLoop {
  documentId: string;
  category: PriorityCategory;
  subject: string | null;
  /** The work object that closed the loop. */
  objectTitle: string | null;
  objectUrl: string | null;
  /** Agnostic terminal bucket — `resolved | abandoned | failed`. */
  stateCategory: StateCategory;
  /** Native provider state for display — `merged`/`closed`/… */
  nativeState: string | null;
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
  slot?: BriefingSlot;
  timezone: IanaTimezone;
  windowStart?: Date;
  windowEnd?: Date;
}

export interface GatherBriefingWithSuppressionAuditResult {
  gather: BriefingGather;
  suppressedByInstruction: BriefingInstructionSuppression[];
  /** Loops dropped because their work object reached a terminal state (ADR-0062). */
  closedLoops: BriefingClosedLoop[];
}

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_PER_BUCKET = 8;
const MAX_CALENDAR_EVENTS = 40;
const WEATHER_FETCH_TIMEOUT_MS = 30_000;

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
  const [rows, suppressionInstructions] = await Promise.all([
    db()
      .select({
        // Select from the documents side of the inner-join — `emailTriage.documentId`
        // is nullable in the thread-keyed schema (pointer can dangle after a doc
        // purge); the joined `documents.id` is guaranteed non-null here.
        documentId: documents.id,
        accountId: documents.accountId,
        category: emailTriage.category,
        confidence: emailTriage.confidence,
        rationale: emailTriage.rationale,
        title: documents.title,
        // Body is needed only to regex a GitHub CI `head_sha` for loop
        // reconciliation; it never leaves this function.
        content: documents.content,
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
      .orderBy(desc(documents.authoredAt)),
    listActiveSuppressionInstructions(args.userId, "exclude_briefing_priority"),
  ]);

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
  const suppressedByInstruction: BriefingInstructionSuppression[] = [];
  // documentId → candidate GitHub `head_sha`s, for the post-partition
  // loop-reconciliation pass (ADR-0062). Only GitHub-notification priority
  // rows land here. Priority buckets stay uncapped until after reconciliation
  // so closed loops do not consume one of the visible slots.
  const githubShasByDoc = new Map<string, string[]>();

  for (const r of rows) {
    const cat = r.category;
    const meta = toRecord(r.metadata);

    if (isSuppressed(cat)) {
      suppressedCounts[cat] += 1;
      continue;
    }
    if (!isPriority(cat)) continue;

    const from = typeof meta.from === "string" ? meta.from : null;
    const instructionSuppression = findSenderSuppression(suppressionInstructions, {
      senderEmail: from,
      accountId: r.accountId,
      effect: "exclude_briefing_priority",
    });
    if (instructionSuppression) {
      suppressedByInstruction.push({
        documentId: r.documentId,
        category: cat,
        sender: from,
        factId: instructionSuppression.factId,
        effect: "exclude_briefing_priority",
      });
      continue;
    }

    buckets[cat].push({
      documentId: r.documentId,
      category: cat,
      confidence: r.confidence,
      rationale: r.rationale,
      subject: r.title,
      from: from,
      snippet: typeof meta.snippet === "string" ? meta.snippet : null,
      authoredAt: r.authoredAt,
      threadUrl: r.sourceThreadId ? gmailThreadUrl(r.sourceThreadId) : null,
    });

    // A GitHub CI/notification email carries a head_sha but no PR number; pull
    // the sha so the reconciliation pass can resolve it back to its PR's state.
    if (isGithubNotificationSender(from)) {
      const shas = extractGithubKeys({ subject: r.title, content: r.content }).map(
        (k) => k.keyValue,
      );
      if (shas.length > 0) githubShasByDoc.set(r.documentId, shas);
    }
  }

  // Loop reconciliation (ADR-0062): drop any priority item whose underlying
  // GitHub PR has reached a loop-closing state. State unknown ⇒ the loop stays
  // live (absence never closes — ADR-0048-D).
  const closedLoops = await reconcileGithubLoops(args.userId, buckets, githubShasByDoc);
  for (const category of PRIORITY_CATEGORIES) {
    buckets[category] = buckets[category].slice(0, maxPerBucket);
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
    suppressedByInstruction,
    closedLoops,
    totalPriority,
    totalSuppressed,
  };
}

/**
 * Resolve each candidate GitHub CI loop to its PR's projected state and drop
 * the closed ones from the priority buckets (mutates `buckets`), returning the
 * dropped set for the evening "closed today" recap.
 *
 * Shas are resolved in parallel — at single-user scale a briefing window holds
 * only a handful of GitHub-notification emails, and `resolveByKey` is a single
 * indexed lookup. A sha that resolves to nothing, or to a non-terminal state,
 * leaves its loop live (the determinism contract: absence never closes).
 */
async function reconcileGithubLoops(
  userId: string,
  buckets: Record<PriorityCategory, BriefingItem[]>,
  shasByDoc: Map<string, string[]>,
): Promise<BriefingClosedLoop[]> {
  if (shasByDoc.size === 0) return [];

  const distinctShas = [...new Set([...shasByDoc.values()].flat())];
  const stateBySha = new Map<string, ObjectState>();
  await Promise.all(
    distinctShas.map(async (sha) => {
      const ref = await objectStateStore.resolveByKey(userId, "github", "head_sha", sha);
      if (!ref) return; // unknown PR → loop stays live
      const state = await objectStateStore.getState(userId, ref);
      if (state) stateBySha.set(sha, state);
    }),
  );

  const closedLoops: BriefingClosedLoop[] = [];
  for (const category of PRIORITY_CATEGORIES) {
    const kept: BriefingItem[] = [];
    for (const item of buckets[category]) {
      const terminal = (shasByDoc.get(item.documentId) ?? [])
        .map((sha) => stateBySha.get(sha))
        .find(
          (state): state is ObjectState => !!state && isLoopClosingCategory(state.stateCategory),
        );
      if (terminal) {
        closedLoops.push({
          documentId: item.documentId,
          category,
          subject: item.subject,
          objectTitle: terminal.title,
          objectUrl: terminal.url,
          stateCategory: terminal.stateCategory,
          nativeState: terminal.nativeState,
        });
      } else {
        kept.push(item);
      }
    }
    buckets[category] = kept;
  }
  return closedLoops;
}

export async function gatherBriefing(args: GatherBriefingArgs): Promise<BriefingGather> {
  return (await gatherBriefingWithSuppressionAudit(args)).gather;
}

export async function gatherBriefingWithSuppressionAudit(
  args: GatherBriefingArgs,
): Promise<GatherBriefingWithSuppressionAuditResult> {
  const slot = args.slot ?? "morning";
  const windowEnd = args.windowEnd ?? localEndOfDay(args.briefingDate, args.timezone);
  // Integration activity shares the email digest's window so the briefing
  // covers one coherent slice of time across sources.
  const activityStart = args.windowStart ?? new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const [digest, calendar, weather, integrationActivity] = await Promise.all([
    gatherBriefingDigest({
      userId: args.userId,
      windowStart: args.windowStart,
      windowEnd,
    }),
    gatherCalendarContribution({
      userId: args.userId,
      briefingDate: args.briefingDate,
      timezone: args.timezone,
      slot,
    }),
    gatherWeatherContribution({
      userId: args.userId,
      briefingDate: args.briefingDate,
      timezone: args.timezone,
    }),
    gatherIntegrationActivity({
      userId: args.userId,
      windowStart: activityStart,
      windowEnd,
    }),
  ]);
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

  // Day-shape (ADR-0064 / #230): reuse the already-fetched activity count so we
  // don't re-query webhook_events; the resolved-object recap is one cheap list.
  const dayShape = await gatherDayShape({
    userId: args.userId,
    windowStart: activityStart,
    windowEnd,
    activityCount: integrationActivity.length,
  });

  // Attention-aware email demand over the FINALIZED priority buckets (#259 /
  // ADR-0064) — scored off the raw `from` (not the shortened `sender` above, so
  // bulk-sender + significance lookups still work) with the same scorer the
  // agent's read path uses. Folds into day-shape so the morning suppression gate
  // leads from "is anything demanding?" instead of a raw count: a quiet day of
  // normal/muted items suppresses rather than promoting a trivial item to the
  // headline. `fyi` remains ambient/suppressed and is not part of the demand
  // count.
  const emailDemand = await scorePriorityEmailDemand(
    args.userId,
    PRIORITY_CATEGORIES.flatMap((category) =>
      digest.buckets[category].map((item) => ({
        sender: item.from,
        subject: item.subject,
        snippet: item.snippet,
        category: item.category,
        occurredAtMs: item.authoredAt?.getTime() ?? null,
      })),
    ),
  );

  return {
    gather: {
      email: {
        categories,
      },
      calendar,
      integration_activity: { items: integrationActivity },
      weather,
      day_of_week: dayContribution(args.briefingDate, args.timezone),
      day_shape: {
        ...dayShape,
        demandingEmailCount: emailDemand.demandingCount,
        topEmailBand: emailDemand.topBand,
      },
    },
    suppressedByInstruction: digest.suppressedByInstruction,
    closedLoops: digest.closedLoops,
  };
}

/**
 * Activity-item count → volume thresholds. Seeded by judgment (tunable from the
 * prod distribution, same surface as the ADR-0064 weights). Zero is the only
 * "quiet" — the whole point of #230 is that any real activity disqualifies it.
 */
const DAY_SHAPE_BUSY_AT = 8;
const MAX_SHIPPED = 6;

/**
 * Deterministic day-shape (ADR-0064 / #230). `activityVolume` is derived from
 * the integration-activity window count; `shipped` is the GitHub work objects
 * that *resolved within the briefing window* (ADR-0062 projection), which feeds
 * the evening "what you shipped" recap. No LLM judgment — this exists so the
 * composer can't call a day with real activity "quiet."
 *
 * `shipped` is windowed on the persisted `stateDeliveredAt` (the delivery time
 * of the event that resolved the object), so a previously-resolved or
 * future-resolved object can't leak into the recap — even on a retry.
 */
export async function gatherDayShape(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
  /** Precomputed integration-activity count; falls back to a fresh query. */
  activityCount?: number;
}): Promise<DayShape> {
  const activityCount =
    args.activityCount ??
    (
      await gatherIntegrationActivity({
        userId: args.userId,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
      })
    ).length;

  const resolved = await objectStateStore.list(args.userId, "github", {
    stateCategory: "resolved",
    deliveredWithin: { start: args.windowStart, end: args.windowEnd },
    limit: MAX_SHIPPED,
  });
  const shipped = resolved
    .filter((o): o is ObjectState & { title: string } => typeof o.title === "string" && !!o.title)
    .slice(0, MAX_SHIPPED)
    .map((o) => ({ title: o.title, ...(o.url ? { url: o.url } : {}) }));

  const activityVolume: DayShape["activityVolume"] =
    activityCount === 0 ? "quiet" : activityCount >= DAY_SHAPE_BUSY_AT ? "busy" : "normal";

  return { activityVolume, shipped };
}

const MAX_ACTIVITY_ITEMS = 25;

interface GithubWebhookPayload {
  ref?: string;
  commits?: unknown[];
  compare?: string;
  pull_request?: { number?: number; title?: string; html_url?: string; merged?: boolean };
  issue?: { number?: number; title?: string; html_url?: string };
  repository?: { full_name?: string; html_url?: string };
  review?: { state?: string; html_url?: string };
}

/**
 * Turn a stored GitHub webhook into a one-line activity description. Reads
 * defensively from the retained payload — any field can be absent on an older
 * or partial delivery, so everything degrades to a sensible generic line.
 */
function describeGithubActivity(
  eventType: string,
  action: string | null,
  repo: string | null,
  payload: GithubWebhookPayload,
): { title: string; status?: IntegrationActivityItem["status"]; url?: string } {
  const where = repo ? ` in ${repo}` : "";
  switch (eventType) {
    case "pull_request": {
      const pr = payload.pull_request ?? {};
      const verb = action === "closed" ? (pr.merged ? "merged" : "closed") : (action ?? "updated");
      const title = `PR #${pr.number ?? "?"} ${verb}${where}${pr.title ? `: ${pr.title}` : ""}`;
      return { title, status: action === "closed" ? "resolved" : "open", url: pr.html_url };
    }
    case "issues": {
      const issue = payload.issue ?? {};
      const title = `Issue #${issue.number ?? "?"} ${action ?? "updated"}${where}${issue.title ? `: ${issue.title}` : ""}`;
      return { title, status: action === "closed" ? "resolved" : "open", url: issue.html_url };
    }
    case "push": {
      const count = Array.isArray(payload.commits) ? payload.commits.length : 0;
      const branch = (payload.ref ?? "").replace("refs/heads/", "");
      const title = `${count} commit${count === 1 ? "" : "s"} pushed${branch ? ` to ${branch}` : ""}${where}`;
      return { title, url: payload.compare };
    }
    case "pull_request_review": {
      const pr = payload.pull_request ?? {};
      const title = `PR #${pr.number ?? "?"} ${payload.review?.state ?? "reviewed"}${where}`;
      return { title, status: "open", url: payload.review?.html_url ?? pr.html_url };
    }
    default:
      return { title: `${eventType}${action ? ` ${action}` : ""}${where}` };
  }
}

/**
 * Recent GitHub App activity for the briefing window (ADR-0052), sourced from
 * the idempotent `webhook_events` log. Empty when nothing fired or GitHub
 * isn't connected — represented as `[]`, never an error.
 */
async function gatherIntegrationActivity(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<IntegrationActivityItem[]> {
  const rows = await db()
    .select({
      id: webhookEvents.id,
      eventType: webhookEvents.eventType,
      action: webhookEvents.action,
      repo: webhookEvents.repo,
      payload: webhookEvents.payload,
      deliveredAt: webhookEvents.deliveredAt,
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.userId, args.userId),
        eq(webhookEvents.provider, "github"),
        gte(webhookEvents.deliveredAt, args.windowStart),
        lte(webhookEvents.deliveredAt, args.windowEnd),
      ),
    )
    .orderBy(desc(webhookEvents.deliveredAt))
    .limit(MAX_ACTIVITY_ITEMS);

  return rows.map((row) => {
    const payload = (row.payload ?? {}) as GithubWebhookPayload;
    const { title, status, url } = describeGithubActivity(
      row.eventType,
      row.action,
      row.repo,
      payload,
    );
    return {
      id: row.id,
      provider: "github",
      source: "direct_api",
      activityCategory: "work",
      providerKind: row.action
        ? `github.${row.eventType}.${row.action}`
        : `github.${row.eventType}`,
      title,
      status,
      severity: "info",
      occurredAt: row.deliveredAt.toISOString(),
      url,
      relatedRepo: row.repo ?? undefined,
    } satisfies IntegrationActivityItem;
  });
}

export interface GatherCalendarArgs {
  userId: string;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: string;
  timezone: IanaTimezone;
  slot: BriefingSlot;
}

export async function gatherCalendarContribution(
  args: GatherCalendarArgs,
): Promise<CalendarContribution | null> {
  const creds = await db()
    .select({
      id: integrationCredentials.id,
      scopes: integrationCredentials.scopes,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, args.userId),
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.status, "active"),
      ),
    );

  const calendarCreds = creds.filter((cred) => {
    const granted = toStringArray(cred.scopes);
    return granted.includes(CALENDAR_READONLY_SCOPE) || granted.includes(CALENDAR_EVENTS_SCOPE);
  });
  if (calendarCreds.length === 0) return null;

  const { timeMin, timeMax } = calendarWindow(args.briefingDate, args.timezone, args.slot);
  const events: CalendarContribution["events"] = [];
  let successfulReads = 0;

  for (const cred of calendarCreds) {
    try {
      const accessToken = await getFreshAccessToken(cred.id);
      const result = await listEvents({
        accessToken,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: MAX_CALENDAR_EVENTS,
      });
      successfulReads++;
      for (const event of result.events) {
        events.push(calendarEventToContributionEvent(cred.id, event));
      }
    } catch (err) {
      console.warn(`[briefing.gather] calendar unavailable credential=${cred.id}:`, toMessage(err));
    }
  }

  if (successfulReads === 0) return null;
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events: events.slice(0, MAX_CALENDAR_EVENTS) };
}

function calendarWindow(
  briefingDate: string,
  timezone: IanaTimezone,
  slot: BriefingSlot,
): { timeMin: Date; timeMax: Date } {
  const dayStart = localStartOfDay(briefingDate, timezone);
  const windowEnd = localStartOfDay(addLocalDays(briefingDate, 2), timezone);
  const now = new Date();
  const timeMin = slot === "evening" && now > dayStart && now < windowEnd ? now : dayStart;
  return { timeMin, timeMax: windowEnd };
}

function calendarEventToContributionEvent(
  credentialId: string,
  event: CalendarEvent,
): CalendarContribution["events"][number] {
  return {
    eventId: `${credentialId}:${event.id}`,
    title: event.summary?.trim() || "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    attendees: (event.attendees ?? [])
      .map((a) => {
        if (!a.email) return null;
        return a.displayName ? `${a.displayName} <${a.email}>` : a.email;
      })
      .filter((a): a is string => a !== null),
    ...(event.location ? { location: event.location } : {}),
  };
}

async function gatherWeatherContribution(args: {
  userId: string;
  briefingDate: string;
  timezone: IanaTimezone;
}): Promise<WeatherContribution | null> {
  const location = await resolveWeatherLocation(args.userId, args.timezone);
  if (!location) return null;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(location.lat));
    url.searchParams.set("longitude", String(location.lng));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code");
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    );
    url.searchParams.set("start_date", args.briefingDate);
    url.searchParams.set("end_date", args.briefingDate);
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`[weather] ${res.status} ${body.slice(0, 300)}`);
    }
    const parsed = openMeteoSchema.parse(await res.json());
    const current = parsed.current;
    const daily = parsed.daily;
    if (!current) return null;

    return {
      current: {
        temperatureC: current.temperature_2m,
        apparentTemperatureC: current.apparent_temperature,
        description: describeWeatherCode(current.weather_code),
      },
      forecast: {
        highC: daily?.temperature_2m_max[0] ?? current.temperature_2m,
        lowC: daily?.temperature_2m_min[0] ?? current.temperature_2m,
        precipitationMm: daily?.precipitation_sum[0] ?? 0,
        description: describeWeatherCode(daily?.weather_code[0] ?? current.weather_code),
      },
    };
  } catch (err) {
    console.warn(
      `[briefing.gather] weather unavailable location=${location.label}:`,
      toMessage(err),
    );
    return null;
  }
}

const openMeteoSchema = z.object({
  current: z
    .object({
      temperature_2m: z.number(),
      apparent_temperature: z.number(),
      weather_code: z.number().int(),
    })
    .optional(),
  daily: z
    .object({
      temperature_2m_max: z.array(z.number()),
      temperature_2m_min: z.array(z.number()),
      precipitation_sum: z.array(z.number()),
      weather_code: z.array(z.number().int()),
    })
    .optional(),
});

async function resolveWeatherLocation(
  userId: string,
  timezone: IanaTimezone,
): Promise<WeatherFallbackLocation | null> {
  const pref = await getPreference(userId, "location");
  const parsed = parseWeatherLocation(pref?.value);
  return parsed ?? weatherFallbackFor(timezone);
}

function parseWeatherLocation(value: unknown): WeatherFallbackLocation | null {
  if (!isRecord(value)) return null;
  const record = value;
  const lat = parseCoord(record.lat ?? record.latitude);
  const lng = parseCoord(record.lng ?? record.lon ?? record.longitude);
  if (lat === null || lng === null) return null;
  const label =
    typeof record.label === "string"
      ? record.label
      : typeof record.city === "string"
        ? record.city
        : typeof record.name === "string"
          ? record.name
          : `${lat},${lng}`;
  return { lat, lng, label };
}

function parseCoord(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function describeWeatherCode(code: number): string {
  if (code === 0) return "clear sky";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code >= 45 && code <= 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return "unknown conditions";
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

export { PRIORITY_CATEGORIES, SUPPRESSED_CATEGORIES };
