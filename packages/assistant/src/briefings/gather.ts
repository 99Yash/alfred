import type {
  BriefingClosedLoop,
  BriefingGather,
  BriefingLoopRelevance,
  BriefingSlot,
  CalendarContribution,
  DayShape,
  IanaTimezone,
  IntegrationActivityItem,
  LoopClosingStateCategory,
  StateCategory,
  WeatherContribution,
  WeatherFallbackLocation,
} from "@alfred/contracts";
import {
  closesOpenAsk,
  closureCandidate,
  GOOGLE_SCOPE,
  getObjectDef,
  getStringPath,
  isRecord,
  parseEventTypeName,
  parseGmailDocumentMetadata,
  redactSecrets,
  toMessage,
  toStringArray,
  weatherFallbackFor,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { INBOUND_SOURCES } from "@alfred/assistant/connections/ingress";
import {
  documents,
  emailTriage,
  typedEventReceipts,
  integrationCredentials,
} from "@alfred/db/schemas";
import {
  type CalendarEvent,
  getFreshAccessToken,
  listEvents,
  type TriageCategory,
} from "@alfred/integrations/google";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  firstClosingObject,
  objectStateStore,
  proposeObjectKeys,
  reconcileEvidence,
  type ObjectState,
  type ReconcileCandidates,
  type ReconcileResult,
} from "@alfred/assistant/connections";
import {
  gatherVerifiedPulls,
  verifyApprovedMcpHealth,
} from "@alfred/assistant/connections/verified-pull";
import { getPreference } from "@alfred/assistant/settings";
import { getMcpExecutionBroker } from "@alfred/assistant/tool-runtime/mcp";
import { findSenderSuppression, listActiveSuppressionInstructions } from "../knowledge";
import {
  addDays,
  formatDay,
  inZone,
  weekdayIndex,
  type LocalDateKey,
} from "@alfred/assistant/time";
import {
  assessLoopRelevance,
  liveNativeStateReader,
  type ApprovedLoopState,
  type LiveNativeStateReader,
} from "./relevance";
import { scorePriorityEmailDemand } from "./read";
import { shortenFrom } from "./sender";

/**
 * Inbox briefing data (ADR-0025 #2). Only priority categories are listed;
 * the rest are counted ("+12 newsletters"). `urgent` comes first so it is never buried.
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
  threadUrl: string | null;
}

export interface BriefingDigest {
  windowStart: Date;
  windowEnd: Date;
  /** Empty arrays are kept and render as "nothing here". */
  buckets: Record<PriorityCategory, BriefingItem[]>;
  suppressedCounts: Record<SuppressedCategory, number>;
  /**
   * Trigger fields for every triaged row, including `fyi`. Verified-pull triggers read this,
   * not `buckets`, so a failure notice triaged as `fyi` still triggers a live read.
   */
  triggerItems: { subject: string | null; from: string | null; snippet: string | null }[];
  /** Priority items dropped because a standing instruction matched the sender. */
  suppressedByInstruction: BriefingInstructionSuppression[];
  /** Items whose work object reached a terminal state (ADR-0062). Feeds the evening recap. */
  closedLoops: BriefingClosedLoop[];
  loopRelevance: BriefingLoopRelevance[];
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

export interface GatherBriefingDigestArgs {
  userId: string;
  /** Defaults to 24h before `windowEnd`. */
  windowStart?: Date | undefined;
  /** Defaults to "now". */
  windowEnd?: Date;
  /** Cap per bucket. */
  maxPerBucket?: number;
}

export interface GatherBriefingArgs {
  userId: string;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: LocalDateKey;
  slot?: BriefingSlot;
  timezone: IanaTimezone;
  windowStart?: Date | undefined;
  windowEnd?: Date;
}

export interface GatherBriefingWithSuppressionAuditResult {
  gather: BriefingGather;
  suppressedByInstruction: BriefingInstructionSuppression[];
  /** Loops dropped because their work object reached a terminal state (ADR-0062). */
  closedLoops: BriefingClosedLoop[];
  /** Check-before-remind verdicts (#1194). */
  loopRelevance: BriefingLoopRelevance[];
}

const DEFAULT_WINDOW_HOURS = 24;

const DEFAULT_MAX_PER_BUCKET = 8;

const MAX_CALENDAR_EVENTS = 40;

const WEATHER_FETCH_TIMEOUT_MS = 30_000;

/** Bucket the window's triaged email. Reads `email_triage` only; no Gmail call. */
export async function gatherBriefingDigest(
  args: GatherBriefingDigestArgs,
): Promise<BriefingDigest> {
  const windowEnd = args.windowEnd ?? new Date();

  const windowStart =
    args.windowStart ?? new Date(windowEnd.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);

  const maxPerBucket = args.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;

  // One query, then partition in JS.
  const [rows, suppressionInstructions] = await Promise.all([
    db()
      .select({
        // `emailTriage.documentId` can dangle after a purge; the joined id cannot.
        documentId: documents.id,
        accountId: documents.accountId,
        category: emailTriage.category,
        confidence: emailTriage.confidence,
        rationale: emailTriage.rationale,
        title: documents.title,
        // Only for the CI `head_sha` regex; it never leaves this function.
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
          // `authoredAt` can be days old on a backfilled thread; window on ingest.
          gte(documents.ingestedAt, windowStart),
          lte(documents.ingestedAt, windowEnd),
        ),
      )
      .orderBy(desc(documents.authoredAt)),
    listActiveSuppressionInstructions(args.userId),
  ]);

  const newPriorityBucket = (): BriefingItem[] => [];

  const buckets = {
    urgent: newPriorityBucket(),
    action_needed: newPriorityBucket(),
    follow_up: newPriorityBucket(),
    awaiting_reply: newPriorityBucket(),
    meeting: newPriorityBucket(),
    payment: newPriorityBucket(),
  };

  const suppressedCounts = {
    fyi: 0,
    done: 0,
    newsletter: 0,
    marketing: 0,
  };

  const suppressedByInstruction: BriefingInstructionSuppression[] = [];
  // Every triaged row, so a Railway failure triaged as `fyi` still reaches verified pull.
  const triggerItems: BriefingDigest["triggerItems"] = [];
  // Buckets stay uncapped until reconciliation, so closed loops do not take visible slots.
  const keyCandidates: ReconcileCandidates<"about">[] = [];

  for (const r of rows) {
    const cat = r.category;
    const meta = parseGmailDocumentMetadata(r.metadata);

    triggerItems.push({
      subject: r.title,
      from: meta.from ?? null,
      snippet: meta.snippet ?? null,
    });

    if (isSuppressed(cat)) {
      suppressedCounts[cat] += 1;
      continue;
    }

    if (!isPriority(cat)) continue;

    const from = meta.from ?? null;

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
      snippet: meta.snippet ?? null,
      authoredAt: r.authoredAt,
      threadUrl: r.sourceThreadId ? gmailThreadUrl(r.sourceThreadId) : null,
    });

    // Propose keys here, while the body is in hand, so content never reaches the resolve phase.
    const keys = proposeObjectKeys(
      { id: r.documentId, text: { subject: r.title ?? "", content: r.content } },
      { reading: "about", sender: from },
    );

    if (keys.length > 0) keyCandidates.push({ id: r.documentId, keys });
  }

  // Approved MCP health reads run before reconciliation. They add candidates; they never close.
  const priorityLoops = PRIORITY_CATEGORIES.flatMap((category) => buckets[category]);

  const approvedHealth = await verifyApprovedMcpHealth(
    {
      userId: args.userId,
      loops: priorityLoops,
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

  const candidatesByLoop = new Map(
    keyCandidates.map((candidate) => [candidate.id, [...candidate.keys]]),
  );

  for (const result of approvedHealth) {
    if (!result.candidate) continue;

    candidatesByLoop.set(result.documentId, [
      ...(candidatesByLoop.get(result.documentId) ?? []),
      result.candidate,
    ]);
  }

  const reconciliationCandidates = [...candidatesByLoop].map(([id, keys]) => ({ id, keys }));

  // Drop items whose work object is closed (ADR-0062). Unknown state stays live.
  // Relevance then runs on the survivors, before the per-bucket cap (#1194).
  const reconciliation = await dropClosedLoops(args.userId, buckets, reconciliationCandidates);
  const approvedStates = new Map<string, ApprovedLoopState>();
  const unverifiedDetails = new Map<string, string>();

  for (const result of approvedHealth) {
    if (result.state && result.candidate) {
      approvedStates.set(result.documentId, { state: result.state, detail: result.detail });
    } else if (!result.state) {
      unverifiedDetails.set(result.documentId, result.detail);
    }
  }

  const loopRelevance = await assessLoopRelevance({
    userId: args.userId,
    loops: PRIORITY_CATEGORIES.flatMap((category) => buckets[category]),
    reconciled: reconciliation.reconciled,
    approvedStates,
    unverifiedDetails,
  });

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
    triggerItems,
    suppressedByInstruction,
    closedLoops: reconciliation.closedLoops,
    loopRelevance,
    totalPriority,
    totalSuppressed,
  };
}

/**
 * Drop priority items whose work object is closed, and return them for the evening recap.
 * Unresolved, ambiguous, or non-closing keys keep the loop live.
 * A kind with `closesAskFrom: "live_confirmation"` (a Sentry issue, ADR-0103) needs a live
 * read first. A missing reader or a failed read keeps the ask.
 */
async function dropClosedLoops(
  userId: string,
  buckets: Record<PriorityCategory, BriefingItem[]>,
  candidates: readonly ReconcileCandidates<"about">[],
): Promise<{
  closedLoops: BriefingClosedLoop[];
  reconciled: ReconcileResult<"about">;
}> {
  if (candidates.length === 0) return { closedLoops: [], reconciled: new Map() };

  const reconciled = await reconcileEvidence({ userId, subjects: candidates });

  const closedLoops: BriefingClosedLoop[] = [];

  // One live read per distinct object. A failure resolves to null, so the ask stays.
  const liveByObject = new Map<string, Promise<StateCategory | null>>();

  const confirmLive = (
    state: ObjectState,
    read: LiveNativeStateReader,
  ): Promise<StateCategory | null> => {
    const objectRef = `${state.provider}:${state.kind}:${state.externalId}`;
    const pending = liveByObject.get(objectRef);

    if (pending) return pending;

    // An unknown token and an archived issue both normalize to non-closing.
    const confirmation = read(userId, state.externalId)
      .then((nativeState) => getObjectDef(state.provider).normalize(state.kind, nativeState))
      .catch((err: unknown) => {
        console.warn(
          `[briefing.gather] live closure confirmation failed object=${objectRef} :: ${redactSecrets(toMessage(err))}`,
        );

        return null;
      });

    liveByObject.set(objectRef, confirmation);

    return confirmation;
  };

  const assertClosure = async (state: ObjectState): Promise<LoopClosingStateCategory | null> => {
    const candidate = closureCandidate(state.provider, state.kind, state.stateCategory);

    if (!candidate) return null;

    // Pass the proof this branch holds, never `candidate.proof`: that is the demand,
    // and passing it back would admit every kind.
    if (candidate.proof === "stored_projection")
      return closesOpenAsk(state.provider, state.kind, state.stateCategory, "stored_projection");

    const read = liveNativeStateReader(state);

    // Stored state is not proof for this kind and there is no reader: keep the ask.
    if (!read) return null;

    const live = await confirmLive(state, read);

    return live === null
      ? null
      : closesOpenAsk(state.provider, state.kind, live, "live_confirmation");
  };

  for (const category of PRIORITY_CATEGORIES) {
    const kept: BriefingItem[] = [];

    for (const item of buckets[category]) {
      const closed = firstClosingObject(reconciled.get(item.documentId));
      const asserted = closed ? await assertClosure(closed.state) : null;

      if (!closed || !asserted) {
        kept.push(item);
        continue;
      }

      closedLoops.push({
        documentId: item.documentId,
        category,
        subject: item.subject,
        objectTitle: closed.state.title,
        objectUrl: closed.state.url,
        stateCategory: asserted,
        nativeState: closed.state.nativeState,
      });
    }

    buckets[category] = kept;
  }

  return { closedLoops, reconciled };
}

export async function gatherBriefing(args: GatherBriefingArgs): Promise<BriefingGather> {
  return (await gatherBriefingWithSuppressionAudit(args)).gather;
}

export async function gatherBriefingWithSuppressionAudit(
  args: GatherBriefingArgs,
): Promise<GatherBriefingWithSuppressionAuditResult> {
  const slot = args.slot ?? "morning";
  const windowEnd = args.windowEnd ?? localEndOfDay(args.briefingDate, args.timezone);
  // Activity uses the email window.
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

  // Verified pull (#1094, #1192): a triaged deploy failure triggers a live status read.
  // Verdicts go into activity, not into the email buckets.
  const verifiedPull = await gatherVerifiedPulls({
    userId: args.userId,
    digestItems: digest.triggerItems,
  });

  // Runs after the verified pull, so a day whose only activity is a Railway failure is not quiet.
  const dayShape = await gatherDayShape({
    userId: args.userId,
    windowStart: activityStart,
    windowEnd,
    activityCount: integrationActivity.length + verifiedPull.length,
  });

  // Demand over the final buckets (ADR-0064). Use the raw `from`, not the shortened
  // `sender`, so bulk and significance lookups work.
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
      integration_activity: { items: [...integrationActivity, ...verifiedPull] },
      weather,
      day_of_week: dayContribution(args.briefingDate),
      day_shape: {
        ...dayShape,
        demandingEmailCount: emailDemand.demandingCount,
        topEmailBand: emailDemand.topBand,
      },
    },
    suppressedByInstruction: digest.suppressedByInstruction,
    closedLoops: digest.closedLoops,
    loopRelevance: digest.loopRelevance,
  };
}

/** Tunable. Zero activity is the only "quiet" (#230). */
const DAY_SHAPE_BUSY_AT = 8;

const MAX_SHIPPED = 6;

/**
 * Day shape without an LLM, so the composer cannot call an active day "quiet" (ADR-0064).
 * `shipped` filters on `stateDeliveredAt`, so a retry does not pull in objects resolved
 * outside the window.
 */
export async function gatherDayShape(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
  /** Falls back to a fresh query. */
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

/** GitHub activity from `event_receipts` (ADR-0052, ADR-0097). Empty, not an error, when none. */
async function gatherIntegrationActivity(args: {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<IntegrationActivityItem[]> {
  const rows = await db()
    .select({
      id: typedEventReceipts.id,
      eventType: typedEventReceipts.eventType,
      payload: typedEventReceipts.payload,
      deliveredAt: typedEventReceipts.deliveredAt,
    })
    .from(typedEventReceipts)
    .where(
      and(
        eq(typedEventReceipts.userId, args.userId),
        eq(typedEventReceipts.provider, "github"),
        gte(typedEventReceipts.deliveredAt, args.windowStart),
        lte(typedEventReceipts.deliveredAt, args.windowEnd),
      ),
    )
    .orderBy(desc(typedEventReceipts.deliveredAt))
    .limit(MAX_ACTIVITY_ITEMS);

  // One deployment relays several receipts (`pending`, `ready`, `promoted`).
  // Keep only the newest per deployment, or one relay counts several times
  // toward `DAY_SHAPE_BUSY_AT` (#1167).
  const seenDeployments = new Set<string>();

  return rows.flatMap((row) => {
    // A name the github entry does not declare was already marked `failed` by the deliver job.
    const eventType = parseEventTypeName("github", row.eventType);

    if (!eventType) return [];

    if (eventType === "repository_dispatch") {
      const deploymentId = getStringPath(row.payload, "client_payload", "id");

      if (deploymentId) {
        if (seenDeployments.has(deploymentId)) return [];

        seenDeployments.add(deploymentId);
      }
    }

    const action = getStringPath(row.payload, "action");
    const repo = getStringPath(row.payload, "repository", "full_name");
    const { title, status, url } = INBOUND_SOURCES.github.describe(eventType, row.payload);

    return [
      {
        id: row.id,
        provider: "github",
        source: "direct_api",
        activityCategory: "work",
        providerKind: action ? `github.${eventType}.${action}` : `github.${eventType}`,
        title,
        status,
        severity: "info",
        occurredAt: row.deliveredAt.toISOString(),
        url,
        relatedRepo: repo ?? undefined,
      } satisfies IntegrationActivityItem,
    ];
  });
}

export interface GatherCalendarArgs {
  userId: string;
  /** YYYY-MM-DD calendar date in the user's timezone. */
  briefingDate: LocalDateKey;
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

    return (
      granted.includes(GOOGLE_SCOPE.calendar.readonly) ||
      granted.includes(GOOGLE_SCOPE.calendar.events)
    );
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

async function gatherWeatherContribution(args: {
  userId: string;
  briefingDate: LocalDateKey;
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

/** Gmail picks the active account, so we need not know which one is signed in. */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function threadIdFromGmailUrl(url: string | null): string {
  if (!url) return "";
  const tail = url.slice(url.lastIndexOf("/") + 1);

  return decodeURIComponent(tail);
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
