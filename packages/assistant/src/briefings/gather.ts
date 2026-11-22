import type {
  BriefingClosedLoop,
  BriefingGather,
  BriefingLoop,
  BriefingSlot,
  CalendarContribution,
  DayShape,
  IanaTimezone,
  GatherInput,
  GatherProvenance,
  WeatherContribution,
} from "@alfred/contracts";
import { mailboxLabel, parseGmailDocumentMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { integrations } from "@alfred/integrations";
import {
  type CalendarEvent,
  GoogleCredentialSelectionError,
  type GoogleCredential,
  type TriageCategory,
} from "@alfred/integrations/google";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  objectStateStore,
  readBriefingBrokenConnections,
  type ActivityWindow,
  type ObjectState,
} from "@alfred/assistant/connections";
// oxlint-disable-next-line no-restricted-imports -- #1684 rows 1, 3 and 8: the GitHub merged read and the deploy status reads move behind readActivity and verifyLoops; the approved MCP health read stays a fold before verifyLoops until a later ADR-0120 slice (decision 6, amended)
import {
  gatherGithubMergedPullRequests,
  gatherVerifiedPulls,
  shippedFromGithubRead,
  verifyApprovedMcpHealth,
  type GithubMergedRead,
  type GithubMergedReadOutcome,
  type VerifiedPullOutcome,
  type VerifiedPullTriggerItem,
} from "@alfred/assistant/connections/verified-pull";
import { type UserSettings, userIdentity } from "@alfred/assistant/settings";
import { getMcpExecutionBroker } from "@alfred/assistant/tool-runtime/mcp";
import {
  countActivityActs,
  readActivity,
  readUserLocation,
  type ExtraLoopMail,
  type UserLocation,
  verifyLoops,
  type VerifyLoopsResult,
} from "../knowledge";
import {
  addDays,
  formatDay,
  inZone,
  weekdayIndex,
  type LocalDateKey,
} from "@alfred/assistant/time";
import {
  readBriefingActivityWindow,
  scorePriorityEmailDemand,
  type BriefingActivityWindow,
} from "./read";
import { activityItemsOf } from "./activity-lines";
import {
  activityRecordProvenance,
  activityWindowProvenance,
  boundProvenance,
  emailProvenance,
  githubMergedProvenance,
  googleSelectionProvenance,
  live,
  logProvenance,
  mergeInputProvenance,
  readFailed,
  splitVerifiedPullActivity,
  placeProvenance,
  type Sourced,
  type StatedProvenance,
} from "./provenance";
import { gatherOfficialWarnings } from "./official-warnings";
import { logger } from "@alfred/logging";

/**
 * Inbox briefing data (ADR-0025 #2). Only priority categories are listed;
 * the rest are counted ("+12 news"). `urgent` comes first so it is never buried.
 */

const PRIORITY_CATEGORIES = [
  "urgent",
  "action",
  "reply",
  "meeting",
  "receipt",
] as const satisfies readonly TriageCategory[];

const SUPPRESSED_CATEGORIES = [
  "fyi",
  "done",
  "news",
  "promo",
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
  threadId: string | null;
  /** Account email of the connection that holds the thread; null when no credential names it. */
  mailbox: string | null;
}

export interface BriefingDigest {
  windowStart: Date;
  windowEnd: Date;
  /** Empty arrays are kept and render as "nothing here". */
  buckets: Record<PriorityCategory, BriefingItem[]>;
  suppressedCounts: Record<SuppressedCategory, number>;
  /**
   * Verified-pull outcomes, one per pull (#1094, #1192). The pull runs before reconciliation, so
   * a failure mail reconciles against the target's state as of this gather.
   */
  verifiedPull: VerifiedPullOutcome[];
  /**
   * The window's merged pull requests, read live from GitHub (ADR-0062 amendment 2026-10-27).
   * The read folds into existing rows before reconciliation. A miss and a fault are two
   * variants; only `completed` carries a read.
   */
  githubMerged: GithubMergedReadOutcome;
  /**
   * Items whose every thing is `closed` (ADR-0120 decision 8). Feeds the open-ask guard and the
   * `briefings.closed_loops` column. The composer recap reads `loops` through `list_loops`.
   */
  closedLoops: BriefingClosedLoop[];
  /** One item for each loop of the verify set (`verifyLoops`). */
  loops: BriefingLoop[];
  /** `unavailable` when `verifyLoops` faulted (ADR-0117 decision 1). */
  loopsProvenance: StatedProvenance;
  totalPriority: number;
  totalSuppressed: number;
}

export interface GatherBriefingDigestArgs {
  userId: string;
  /** Defaults to 24h before `windowEnd`. */
  windowStart?: Date | undefined;
  /** Defaults to "now". */
  windowEnd?: Date;
  /**
   * The window of the GitHub merged read: the briefing's activity window
   * (`readBriefingActivityWindow`). It is not the email window.
   */
  activityWindow: ActivityWindow;
  /** Cap per bucket. */
  maxPerBucket?: number;
  /** The abort of the whole gather. It stops the live loop reads when another input fails. */
  signal: AbortSignal;
}

export interface GatherBriefingArgs {
  userId: string;
  /** The step's bind for `userId`. The weather location reads from its load, not a new SELECT. */
  settings: UserSettings;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: LocalDateKey;
  slot?: BriefingSlot;
  timezone: IanaTimezone;
  /** The email window. The start defaults to 24h before the end. */
  windowStart?: Date | undefined;
  windowEnd?: Date;
  /**
   * The window of the activity record and the GitHub merged read. The workflow computes it one
   * time and gives the same window to the composer tools. Absent: the gather reads it with
   * `readBriefingActivityWindow`, up to `windowEnd`. Its `clippedFrom` becomes a composer fact
   * (`activityWindowProvenance`) in the stored provenance, so a retried compose step reads it too.
   */
  activityWindow?: BriefingActivityWindow;
}

export interface GatherBriefingWithSuppressionAuditResult {
  gather: BriefingGather;
  /** Priority mails dropped because every thing that they point to is `closed` (ADR-0120). */
  closedLoops: BriefingClosedLoop[];
  /** The verdict of each loop (ADR-0120 decision 8). */
  loops: BriefingLoop[];
}

const DEFAULT_WINDOW_HOURS = 24;

const DEFAULT_MAX_PER_BUCKET = 8;

const MAX_CALENDAR_EVENTS = 40;

/**
 * Bound on the whole weather input: the geocode of the user's place and the forecast read. The
 * forecast had 30 seconds alone before; the geocode stops sooner on its own timeout.
 */
const WEATHER_DEADLINE_MS = 30_000;

/** Bucket the window's triaged email. Reads `email_triage` only; no Gmail call. */
export async function gatherBriefingDigest(
  args: GatherBriefingDigestArgs,
): Promise<BriefingDigest> {
  const windowEnd = args.windowEnd ?? new Date();

  const windowStart =
    args.windowStart ?? new Date(windowEnd.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);

  const maxPerBucket = args.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;

  // One query, then partition in JS.
  const [rows, identity] = await Promise.all([
    db()
      .select({
        // `emailTriage.documentId` can dangle after a purge; the joined id cannot.
        documentId: documents.id,
        accountId: documents.accountId,
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
          // `authoredAt` can be days old on a backfilled thread; window on ingest.
          gte(documents.ingestedAt, windowStart),
          lte(documents.ingestedAt, windowEnd),
        ),
      )
      .orderBy(desc(documents.authoredAt)),
    userIdentity({ userId: args.userId }),
  ]);

  const newPriorityBucket = (): BriefingItem[] => [];

  const buckets = {
    urgent: newPriorityBucket(),
    action: newPriorityBucket(),
    reply: newPriorityBucket(),
    meeting: newPriorityBucket(),
    receipt: newPriorityBucket(),
  };

  const suppressedCounts = {
    fyi: 0,
    done: 0,
    news: 0,
    promo: 0,
  };

  // Every triaged row, including `fyi`, so a failure notice triaged as `fyi` still triggers a live read.
  const triggerItems: VerifiedPullTriggerItem[] = [];

  for (const r of rows) {
    const meta = parseGmailDocumentMetadata(r.metadata);
    const from = meta.from ?? null;

    // The stored label. No code applies an instruction since triage slice 4a; the composer
    // reads the instructions in words.
    const cat = r.category;

    triggerItems.push({
      subject: r.title,
      from,
      snippet: meta.snippet ?? null,
    });

    if (isSuppressed(cat)) {
      suppressedCounts[cat] += 1;
      continue;
    }

    if (!isPriority(cat)) continue;

    buckets[cat].push({
      documentId: r.documentId,
      category: cat,
      confidence: r.confidence,
      rationale: r.rationale,
      subject: r.title,
      from: from,
      snippet: meta.snippet ?? null,
      authoredAt: r.authoredAt,
      threadId: r.sourceThreadId,
      mailbox: r.accountId ? (identity.mailboxByAccountId.get(r.accountId) ?? null) : null,
    });
  }

  // The time of the loop run. `windowEnd` can be a frozen watermark or the end of the local day.
  const loopClock = new Date();

  // Verified pull (#1094, #1192): a triaged deploy failure triggers a live status read. Its
  // verdicts go into activity, not into the email buckets. The GitHub read folds the window's
  // merges, so a stored pull request is current when `verifyLoops` reads it. Neither throws.
  // The merged read covers the activity window, not the email window: it is activity, and it is
  // the silence evidence of that window. It reads merge times in `[start, end]`. The record reads
  // the acts whose delivery arrived in `[start - G, end - G)` (`readActivityEvents`), and the gap
  // proof compares each merge time with the gap bounds, so the read can prove a gap after `start`
  // only. ADR-0120 slices 3 and 6 move both reads out of the gather.
  const [verifiedPull, githubMerged] = await Promise.all([
    gatherVerifiedPulls({
      userId: args.userId,
      digestItems: triggerItems,
    }),
    gatherGithubMergedPullRequests({
      userId: args.userId,
      windowStart: args.activityWindow.start,
      windowEnd: args.activityWindow.end,
    }),
  ]);

  // The approved MCP health reads fold before `verifyLoops`, and their keys point the mail at the
  // folded thing. They never close by themselves: `verifyLoops` gives the verdict.
  const priorityItems = PRIORITY_CATEGORIES.flatMap((category) => buckets[category]);

  const approvedHealth = await verifyApprovedMcpHealth(
    {
      userId: args.userId,
      loops: priorityItems,
    },
    {
      callApprovedHealthRead: (input) =>
        getMcpExecutionBroker().callHealthRead({
          userId: input.userId,
          ref: {
            kind: "mcp",
            connectionId: input.connectionId,
            remoteName: input.remoteName,
            catalogRevision: input.catalogRevision,
          },
          descriptorHash: input.descriptorHash,
          mappingRevision: input.mappingRevision,
        }),
    },
  );

  const itemsById = new Map(priorityItems.map((item) => [item.documentId, item]));

  const extraMails = approvedHealth.flatMap((result): ExtraLoopMail[] => {
    const item = itemsById.get(result.documentId);

    if (!result.candidate || !item) return [];

    return [
      {
        documentId: item.documentId,
        occurredAt: item.authoredAt ?? loopClock,
        category: item.category,
        keys: [result.candidate],
      },
    ];
  });

  const verified = await readLoops({
    userId: args.userId,
    clock: loopClock,
    signal: args.signal,
    extraMails,
  });

  // Buckets stay uncapped until here, so closed loops do not take visible slots.
  const closedLoops = dropClosedLoops(buckets, verified.closedMails);

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
    verifiedPull,
    githubMerged,
    closedLoops,
    loops: verified.loops.value,
    loopsProvenance: verified.loops.provenance,
    totalPriority,
    totalSuppressed,
  };
}

/** `verifyLoops`, with a fault as a blind input: no loop, and no mail drops. */
async function readLoops(args: {
  userId: string;
  clock: Date;
  signal: AbortSignal;
  extraMails: readonly ExtraLoopMail[];
}): Promise<{
  loops: Sourced<BriefingLoop[]>;
  closedMails: VerifyLoopsResult["closedMails"];
}> {
  try {
    const result = await verifyLoops(args);

    return {
      loops: { value: result.loops, provenance: [live("loops")] },
      closedMails: result.closedMails,
    };
  } catch (err) {
    logger.warn({ err, userId: args.userId }, "[briefing.gather] verifyLoops failed");

    return {
      loops: { value: [], provenance: [readFailed("loops", "The loop check failed.")] },
      closedMails: new Map(),
    };
  }
}

/**
 * Drop each priority item whose mail points to at least one thing when every such thing is
 * `closed` (ADR-0120 decision 8), and return the dropped items. An `open` or `unverified` thing, or
 * a thing with no checked item, keeps the item: absence and a failed read never close a loop.
 */
function dropClosedLoops(
  buckets: Record<PriorityCategory, BriefingItem[]>,
  closedMails: VerifyLoopsResult["closedMails"],
): BriefingClosedLoop[] {
  const closedLoops: BriefingClosedLoop[] = [];

  for (const category of PRIORITY_CATEGORIES) {
    const kept: BriefingItem[] = [];

    for (const item of buckets[category]) {
      const closing = closedMails.get(item.documentId);

      if (!closing) {
        kept.push(item);
        continue;
      }

      closedLoops.push({
        documentId: item.documentId,
        category,
        subject: item.subject,
        objectTitle: closing.title,
        objectUrl: closing.url,
        stateCategory: closing.stateCategory,
        nativeState: closing.nativeState,
      });
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

  const activityWindow =
    args.activityWindow ??
    (await readBriefingActivityWindow({ userId: args.userId, end: windowEnd }));

  // One place read for weather and warnings. It does not throw: a fault is its `fault` basis.
  // This one deadline bounds the place read and the forecast read together. The warnings feeds
  // have their own deadline (`OFFICIAL_WARNINGS_DEADLINE_MS`), which starts after the place read.
  const weatherDeadline = AbortSignal.timeout(WEATHER_DEADLINE_MS);

  // When a read below fails, `Promise.all` rejects and the gather stops. This controller then stops
  // the warnings feed reads and the live loop reads, so they do not run on to their own deadline.
  const gatherCancel = new AbortController();

  const placeRead = readUserLocation({
    userId: args.userId,
    settings: args.settings,
    timezone: args.timezone,
    signal: weatherDeadline,
  });

  const [digest, calendar, weather, officialWarnings, activity, brokenConnections, email] =
    await Promise.all([
      gatherBriefingDigest({
        userId: args.userId,
        windowStart: args.windowStart,
        windowEnd,
        activityWindow,
        signal: gatherCancel.signal,
      }),
      gatherCalendarContribution({
        userId: args.userId,
        briefingDate: args.briefingDate,
        timezone: args.timezone,
        slot,
      }),
      placeRead.then((place) =>
        gatherWeatherContribution({
          located: place,
          deadline: weatherDeadline,
          briefingDate: args.briefingDate,
          timezone: args.timezone,
        }),
      ),
      placeRead.then((place) =>
        gatherOfficialWarnings({
          userId: args.userId,
          located: place,
          timezone: args.timezone,
          briefingDate: args.briefingDate,
          now: new Date(),
          signal: gatherCancel.signal,
        }),
      ),
      readActivity({ userId: args.userId, window: activityWindow, clock: new Date() }),
      readBriefingBrokenConnections(args.userId),
      emailProvenance(args.userId, () =>
        integrations({ userId: args.userId, retry: "none" }).google.gmail.readCredential(),
      ),
    ]).catch((err: unknown) => {
      gatherCancel.abort(err);
      throw err;
    });

  const categories: BriefingGather["email"]["categories"] = {};

  for (const category of PRIORITY_CATEGORIES) {
    categories[category] = digest.buckets[category].map((item) => ({
      documentId: item.documentId,
      threadId: item.threadId ?? "",
      ...(item.mailbox ? { mailbox: item.mailbox } : {}),
      subject: item.subject?.trim() || "(no subject)",
      sender: mailboxLabel(item.from) ?? "Unknown sender",
      snippet: item.snippet ?? item.rationale ?? "",
    }));
  }

  const { githubMerged } = digest;

  // A verified pull can report a failure from long ago. It is real, but it is not news.
  const verifiedPull = splitVerifiedPullActivity(digest.verifiedPull, activityWindow.start);

  // Only `completed` carries a read; every fault and the miss fall back to the stored rows.
  const githubMergedRead = githubMerged.status === "completed" ? githubMerged.read : null;

  // Runs after the verified pull, so a day whose only activity is a Railway failure is not quiet.
  // The GitHub read counts merges that no webhook delivered. `max`, not a sum: a delivered merge
  // is in both counts.
  const dayShape = await gatherDayShape({
    userId: args.userId,
    windowStart: activityWindow.start,
    windowEnd: activityWindow.end,
    activityCount:
      Math.max(activity.acts, githubMergedRead?.total ?? 0) + verifiedPull.value.length,
    githubMerged: githubMergedRead,
  });

  // Demand over the final buckets (ADR-0064). Use the raw `from`, not the shortened
  // `sender`, so the recurrence scorer gets the address.
  const emailDemand = scorePriorityEmailDemand(
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

  // The activity record reads only the acts whose delivery arrived in the window
  // (`readActivityEvents`), so only the verified pull (`deploy_status`) can hold an old item. The
  // coverage owns the verdict of each source (`settleActivityCoverage`), and
  // `activityRecordProvenance` gives each verdict its audience.
  // A total table of non-empty lists, so a new member of `GATHER_INPUTS` does not compile until
  // it states at least one entry.
  const provenanceByInput = {
    email: [email],
    calendar: calendar.provenance,
    weather: weather.provenance,
    official_warnings: officialWarnings.provenance,
    integration_activity: mergeInputProvenance("integration_activity", [
      ...activityRecordProvenance({
        userId: args.userId,
        coverage: activity.coverage,
        unreadable: activity.unreadable,
        capped: activity.capped,
        // The digest read the merges over `activityWindow` (`gatherBriefingDigest`).
        evidence: { github: { window: activityWindow, read: githubMerged } },
      }),
      ...activityWindowProvenance(activityWindow),
    ]),
    deploy_status: mergeInputProvenance("deploy_status", verifiedPull.provenance),
    github_merged: [githubMergedProvenance(githubMerged)],
    loops: digest.loopsProvenance,
  } satisfies Record<GatherInput, StatedProvenance>;

  const provenance = boundProvenance(args.userId, Object.values(provenanceByInput).flat());

  logProvenance(args.userId, provenance);

  return {
    gather: {
      email: {
        categories,
      },
      calendar: calendar.value,
      integration_activity: {
        items: [...activityItemsOf(activity.events, MAX_ACTIVITY_ITEMS), ...verifiedPull.value],
      },
      weather: weather.value,
      official_warnings: officialWarnings.value,
      day_of_week: dayContribution(args.briefingDate),
      day_shape: {
        ...dayShape,
        demandingEmailCount: emailDemand.demandingCount,
        topEmailBand: emailDemand.topBand,
      },
      broken_connections: brokenConnections.integrations,
      broken_mcp_connections: brokenConnections.mcp,
      provenance,
    },
    closedLoops: digest.closedLoops,
    loops: digest.loops,
  };
}

/** Tunable. Zero activity is the only "quiet" (#230). */
const DAY_SHAPE_BUSY_AT = 8;

const MAX_SHIPPED = 6;

/**
 * Day shape without an LLM, so the composer cannot call an active day "quiet" (ADR-0064).
 * `shipped` comes from the GitHub read when it completed: it covers merges that no webhook
 * delivered. Else it lists resolved rows by `stateDeliveredAt`, so a retry does not pull in
 * objects resolved outside the window. The two are never merged: a read fold stamps the fold
 * time, so a union would list the same merge in two briefs.
 */
export async function gatherDayShape(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
  /** Falls back to a fresh query. */
  activityCount?: number;
  /** The digest's GitHub read. Absent or `null` falls back to the stored rows. */
  githubMerged?: GithubMergedRead | null;
}): Promise<DayShape> {
  const activityCount =
    args.activityCount ??
    (await countActivityActs({
      userId: args.userId,
      window: { start: args.windowStart, end: args.windowEnd },
    }));

  const activityVolume: DayShape["activityVolume"] =
    activityCount === 0 ? "quiet" : activityCount >= DAY_SHAPE_BUSY_AT ? "busy" : "normal";

  if (args.githubMerged) {
    return {
      activityVolume,
      shipped: shippedFromGithubRead(args.githubMerged, MAX_SHIPPED),
      shippedTotal: args.githubMerged.total,
    };
  }

  const resolved = await objectStateStore.list(args.userId, "github", {
    stateCategory: "resolved",
    deliveredWithin: { start: args.windowStart, end: args.windowEnd },
    limit: MAX_SHIPPED,
  });

  const shipped = resolved
    .filter((o): o is ObjectState & { title: string } => typeof o.title === "string" && !!o.title)
    .slice(0, MAX_SHIPPED)
    .map((o) => ({ title: o.title, ...(o.url ? { url: o.url } : {}) }));

  return { activityVolume, shipped };
}

/** The activity lines that one gather stores. A push group is one line (`activityItemsOf`). */
const MAX_ACTIVITY_ITEMS = 25;

export interface GatherCalendarArgs {
  userId: string;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: LocalDateKey;
  timezone: IanaTimezone;
  slot: BriefingSlot;
}

export async function gatherCalendarContribution(
  args: GatherCalendarArgs,
): Promise<Sourced<CalendarContribution | null>> {
  const calendar = integrations({ userId: args.userId, retry: "none" }).google.calendar;
  let calendarCreds: GoogleCredential[];

  try {
    calendarCreds = await calendar.readCredentials();
  } catch (err) {
    if (err instanceof GoogleCredentialSelectionError) {
      return {
        value: null,
        provenance: [await googleSelectionProvenance(args.userId, "calendar", "calendar", err)],
      };
    }

    throw err;
  }

  const { timeMin, timeMax } = calendarWindow(args.briefingDate, args.timezone, args.slot);
  const events: CalendarContribution["events"] = [];
  let successfulReads = 0;

  for (const cred of calendarCreds) {
    try {
      const result = await calendar.listEvents({
        credentialId: cred.id,
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
      logger.warn({ err }, `[briefing.gather] calendar unavailable credential=${cred.id}`);
    }
  }

  if (successfulReads === 0) {
    return {
      value: null,
      provenance: [readFailed("calendar", "Every calendar read failed.")],
    };
  }

  events.sort((a, b) => a.start.localeCompare(b.start));

  // One account that failed beside one that read is a log line above, not a blind input.
  return {
    value: { events: events.slice(0, MAX_CALENDAR_EVENTS) },
    provenance: [live("calendar")],
  };
}

function calendarWindow(briefingDate: LocalDateKey, timezone: IanaTimezone, slot: BriefingSlot) {
  const zone = inZone(timezone);
  const dayStart = zone.startOf(briefingDate);
  const windowEnd = zone.startOf(addDays(briefingDate, 2));
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

/** `deadline`: the one deadline of the place read and the forecast read together. */
async function gatherWeatherContribution(args: {
  located: UserLocation;
  deadline: AbortSignal;
  briefingDate: LocalDateKey;
  timezone: IanaTimezone;
}): Promise<Sourced<WeatherContribution | null>> {
  const { deadline } = args;
  const { place: location, statement } = placeProvenance("weather", args.located, args.timezone);

  if (location === null) return { value: null, provenance: [statement] };

  // A failed forecast keeps the fallback statement too, so the log still shows which city the
  // read was for.
  const fallback: GatherProvenance[] = statement ? [statement] : [];

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

    const res = await fetch(url, { signal: deadline });

    if (!res.ok) {
      // oxlint-disable-next-line alfred/no-swallowed-catch -- an unreadable error body only drops detail; the thrown error keeps the status
      const body = await res.text().catch(() => "");
      throw new Error(`[weather] ${res.status} ${body.slice(0, 300)}`);
    }

    const parsed = openMeteoSchema.parse(await res.json());
    const current = parsed.current;
    const daily = parsed.daily;

    if (!current) {
      return {
        value: null,
        provenance: [readFailed("weather", "The forecast had no current conditions."), ...fallback],
      };
    }

    const value: WeatherContribution = {
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

    return { value, provenance: [fallback[0] ?? live("weather"), ...fallback.slice(1)] };
  } catch (err) {
    logger.warn({ err }, `[briefing.gather] weather unavailable location=${location.label}`);

    return {
      value: null,
      provenance: [readFailed("weather", "The forecast read failed."), ...fallback],
    };
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

const SUNDAY = 0;

const SATURDAY = 6;

// `briefingDate` is already local; re-projecting it named the wrong day for UTC+13/+14.
// Decide the weekend on `weekdayIndex`, not on a rendered day name.
function dayContribution(briefingDate: LocalDateKey): BriefingGather["day_of_week"] {
  const index = weekdayIndex(briefingDate);

  return {
    dayName: formatDay(briefingDate, "weekday"),
    isWeekend: index === SATURDAY || index === SUNDAY,
  };
}

function localEndOfDay(briefingDate: LocalDateKey, timezone: IanaTimezone): Date {
  return inZone(timezone).startOf(addDays(briefingDate, 1));
}

export { PRIORITY_CATEGORIES, SUPPRESSED_CATEGORIES };
