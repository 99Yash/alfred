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
  /**
   * Minimal trigger fields for every triaged row in the window, including
   * `fyi`-suppressed status noise. Every verified-pull trigger reads
   * this — never `buckets` — so a failure notice triaged as `fyi` still
   * triggers a live read.
   */
  triggerItems: { subject: string | null; from: string | null; snippet: string | null }[];
  /** Priority items dropped because a standing instruction matched the sender. */
  suppressedByInstruction: BriefingInstructionSuppression[];
  /**
   * Priority items dropped because object-state (ADR-0062) shows the underlying
   * work object has reached a terminal state — e.g. a CI-failure email whose PR
   * has since merged. These feed the evening "closed today" recap (ADR-0048 #5).
   */
  closedLoops: BriefingClosedLoop[];
  /** One bounded, non-closing relevance verdict for every still-live priority loop. */
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
  /** Cap per bucket — protects the email body length on busy days. */
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
  /** Check-before-remind verdicts over every still-live priority loop (#1194). */
  loopRelevance: BriefingLoopRelevance[];
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
  // Trigger fields for every triaged row (priority and suppressed alike), so
  // a Railway failure notice triaged as `fyi` still reaches the verified-pull
  // trigger. Built here, where the body and metadata are already in hand.
  const triggerItems: BriefingDigest["triggerItems"] = [];
  // One entry per priority row whose text proposes a work-object key, for the
  // post-partition loop-reconciliation pass (ADR-0062). Priority buckets stay
  // uncapped until after reconciliation so closed loops do not consume one of
  // the visible slots.
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

    // Every deterministic work-object identity this notification carries, as
    // its provider's adapter reads it. The mail is ABOUT one object, so the
    // adapter demands the sender-domain gate and refuses an ambiguous
    // reference. Proposed here, inside the loop that already holds the body,
    // so the row's content is never carried into the resolve phase.
    const keys = proposeObjectKeys(
      { id: r.documentId, text: { subject: r.title ?? "", content: r.content } },
      { reading: "about", sender: from },
    );

    if (keys.length > 0) keyCandidates.push({ id: r.documentId, keys });
  }

  // Owner-reviewed MCP health pulls run BEFORE reconciliation so a matching
  // read can enter the same object-state store the built-ins use. The verifier
  // contributes only exact, data-backed candidates; it never returns closure.
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

  // Loop reconciliation (ADR-0062): drop any priority item whose underlying
  // work object has reached a loop-closing state. State unknown ⇒ the loop stays
  // live (absence never closes — ADR-0048-D). The bounded relevance pass then
  // runs over exactly what survived reconciliation and before presentation
  // capping, so every still-live priority loop carries one verdict (#1194).
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
 * Resolve each candidate loop to its work object's projected state and drop the
 * closed ones from the priority buckets (mutates `buckets`), returning the
 * dropped set for the evening "closed today" recap.
 *
 * The resolve, the exact-beats-prefix precedence, and the closure test are the
 * shared `reconcileEvidence` operation (#1088); this function owns only what is
 * briefing-specific — which bucket an item sits in, and what a closed loop
 * reports. A key that resolves to nothing, to more than one object, or to a
 * state its kind does not treat as closing leaves its loop live (the
 * determinism contract: absence never closes).
 *
 * `firstClosingObject` nominates; this function ASSERTS. A kind the registry
 * declares `closesAskFrom: "live_confirmation"` — a Sentry issue, whose stored
 * `resolved` may be a delayed delivery that reordered (ADR-0103) — is confirmed
 * with a live provider read here before it becomes a `BriefingClosedLoop`. Any
 * other live state, a read failure, or a kind this gather holds no reader for
 * keeps the ask, and a failed read is reported rather than swallowed.
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

  // One live read per distinct object within this gather call — one object
  // named by N items costs one read. A failure resolves to null here so the
  // caller keeps the ask; the warn inside the catch is the report.
  const liveByObject = new Map<string, Promise<StateCategory | null>>();

  const confirmLive = (
    state: ObjectState,
    read: LiveNativeStateReader,
  ): Promise<StateCategory | null> => {
    const objectRef = `${state.provider}:${state.kind}:${state.externalId}`;
    const pending = liveByObject.get(objectRef);

    if (pending) return pending;

    // `normalize` then `closesOpenAsk` (below) are the only readings of the
    // live token: an unknown token and an archived issue both fall out as
    // non-closing with no literal status comparison on this path.
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

    // Each branch passes the proof THIS branch actually holds, as a literal —
    // never `candidate.proof`, which is the registry's DEMAND. Passing the
    // demand back would compare the demand against itself, so the gate would
    // admit every kind and the registry would answer its own question.
    if (candidate.proof === "stored_projection")
      return closesOpenAsk(state.provider, state.kind, state.stateCategory, "stored_projection");

    const read = liveNativeStateReader(state);

    // The registry says stored state does not prove this kind's closure and
    // this gather holds no read for it, so it may not assert one: keep the ask.
    if (!read) return null;

    const live = await confirmLive(state, read);

    // `live` came from the read above, so this branch — and only this branch —
    // holds a live confirmation.
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

  // Verified pull (#1094, #1192): a triaged deployment failure from a
  // connected provider triggers a live status read at gather time, once per
  // registered pull provider (`connections/verified-pull`). Runs after the
  // digest resolves (the failure-mail trigger reads every triaged row,
  // including `fyi`-suppressed status noise) and appends deployment verdict
  // lines beside the receipt-sourced activity — never through the email
  // slice, which only carries triage buckets.
  const verifiedPull = await gatherVerifiedPulls({
    userId: args.userId,
    digestItems: digest.triggerItems,
  });

  // Day-shape (ADR-0064 / #230): reuse the already-fetched activity count so we
  // don't re-query event_receipts; the resolved-object recap is one cheap list.
  // Runs AFTER the verified pull so a day whose only activity is a Railway
  // failure counts that line — otherwise the same briefing would score the
  // day quiet and list the failure.
  const dayShape = await gatherDayShape({
    userId: args.userId,
    windowStart: activityStart,
    windowEnd,
    activityCount: integrationActivity.length + verifiedPull.length,
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

/**
 * Recent GitHub App activity for the briefing window (ADR-0052), sourced from
 * the `event_receipts` rows the ingress route stores for `provider = 'github'`
 * (ADR-0097). Empty when nothing fired or GitHub isn't connected —
 * represented as `[]`, never an error.
 */
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

  // One deployment relays several receipts — `pending`, then `ready`, then
  // `promoted`. Measured on dev, 2026-09-20: 8 `repository_dispatch` receipts
  // for 5 distinct deployments on the busiest such day. This list is what
  // `gatherDayShape` counts, and `DAY_SHAPE_BUSY_AT` is 8, so without a
  // collapse one machine relay reads as several units of the USER's day. Rows
  // arrive newest first, so the surviving line is the deployment's latest
  // state — which is the only state a succession object has (#1167).
  const seenDeployments = new Set<string>();

  return rows.flatMap((row) => {
    // The receipt stores `github.<type>`; a name the github entry does not
    // declare is a row the deliver job already marked `failed`, so it has no
    // activity line either.
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

const SUNDAY = 0;

const SATURDAY = 6;

// `briefingDate` is already a local date key in the user's zone, so the weekday
// is read off the key itself — re-projecting it through the zone is what made a
// UTC+13/+14 user's briefing name the wrong day.
//
// Which days are the weekend is this module's policy, so it is decided here on
// `weekdayIndex` — not by string-matching a *rendered* weekday name against
// "Saturday"/"Sunday", which made a locale choice inside a formatter silently
// load-bearing for a briefing decision.
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
