/** Daily-briefing contract (ADR-0041), shared by the DB columns, sync, and the web. */

import { z } from "zod";

import { attentionBandSchema } from "./attention";
import { LOOP_CLOSING_STATE_CATEGORIES } from "./integration-objects";
import { triageCategorySchema } from "./triage";
import { isIntegrationSlug, LIVE_PROVIDER_SLUGS } from "./integrations";
import { deliveryAlertSchema, mcpConnectionAlertSchema } from "./integration-status";

// ─── Sources + reference kinds ────────────────────────────────────────────

export const GATHER_SOURCE_SLUGS = [
  "email",
  "calendar",
  "integration_activity",
  "weather",
  "day_of_week",
] as const;

export type GatherSourceSlug = (typeof GATHER_SOURCE_SLUGS)[number];

export const gatherSourceSlugSchema = z.enum(GATHER_SOURCE_SLUGS);

export const BRIEFING_REFERENCE_KINDS = ["activity", "meeting", "email"] as const;

export type BriefingReferenceKind = (typeof BRIEFING_REFERENCE_KINDS)[number];

export const briefingReferenceKindSchema = z.enum(BRIEFING_REFERENCE_KINDS);

// ─── IANA timezone (branded string) ───────────────────────────────────────

declare const ianaTimezoneBrand: unique symbol;

export type IanaTimezone = string & { readonly [ianaTimezoneBrand]: true };

/** Built once: `supportedValuesOf` allocates ~600 entries per call. Mutable for memoization. */
const SUPPORTED_TIMEZONES: Set<string> = new Set(Intl.supportedValuesOf("timeZone"));

/**
 * `supportedValuesOf` omits valid aliases such as "UTC" and "Etc/UTC", and the
 * default "UTC" pref once failed every briefing. So try `DateTimeFormat` on a miss.
 */
function isSupportedTimezone(value: string): boolean {
  if (SUPPORTED_TIMEZONES.has(value)) return true;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    SUPPORTED_TIMEZONES.add(value);

    return true;
  } catch {
    return false;
  }
}

export function assertIanaTimezone(value: string): asserts value is IanaTimezone {
  if (!isSupportedTimezone(value)) {
    throw new Error(`Not a recognized IANA timezone: ${value}`);
  }
}

/** The expression form of {@link assertIanaTimezone}. */
export function parseIanaTimezone(value: string): IanaTimezone {
  assertIanaTimezone(value);

  return value;
}

export function isIanaTimezone(value: unknown): value is IanaTimezone {
  if (typeof value !== "string") return false;

  return isSupportedTimezone(value);
}

// Annotated so the output keeps the `IanaTimezone` name. The bare `refine` output is an intersection
// that names the private brand symbol, and a package that emits declarations cannot name it.
export const ianaTimezoneSchema: z.ZodType<IanaTimezone, string> = z
  .string()
  .refine(isIanaTimezone, { message: "Expected an IANA timezone identifier" });

// ─── Per-source contribution shapes ───────────────────────────────────────

const emailContributionItemSchema = z.object({
  documentId: z.string().min(1),
  threadId: z.string(),
  // Account email of the connection that holds the thread. Absent on old rows, and when no active credential maps the account.
  mailbox: z.string().min(1).optional(),
  subject: z.string(),
  sender: z.string(),
  snippet: z.string(),
});

export const emailContributionSchema = z.object({
  categories: z.partialRecord(triageCategorySchema, z.array(emailContributionItemSchema)),
});

export type EmailContribution = z.infer<typeof emailContributionSchema>;

export const calendarContributionSchema = z.object({
  events: z.array(
    z.object({
      eventId: z.string().min(1),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      attendees: z.array(z.string()),
      location: z.string().optional(),
    }),
  ),
});

export type CalendarContribution = z.infer<typeof calendarContributionSchema>;

export const INTEGRATION_ACTIVITY_SOURCES = ["direct_api", "email_triage", "mcp"] as const;

export type IntegrationActivitySource = (typeof INTEGRATION_ACTIVITY_SOURCES)[number];

export const integrationActivitySourceSchema = z.enum(INTEGRATION_ACTIVITY_SOURCES);

export const INTEGRATION_ACTIVITY_CATEGORIES = [
  "work",
  "deploy",
  "incident",
  "account",
  "billing",
  "security",
  "usage",
  "other",
] as const;

export type IntegrationActivityCategory = (typeof INTEGRATION_ACTIVITY_CATEGORIES)[number];

export const integrationActivityCategorySchema = z.enum(INTEGRATION_ACTIVITY_CATEGORIES);

export const INTEGRATION_ACTIVITY_STATUSES = [
  "open",
  "succeeded",
  "failed",
  "resolved",
  "needs_attention",
] as const;

export type IntegrationActivityStatus = (typeof INTEGRATION_ACTIVITY_STATUSES)[number];

export const integrationActivityStatusSchema = z.enum(INTEGRATION_ACTIVITY_STATUSES);

export const INTEGRATION_ACTIVITY_SEVERITIES = ["info", "warning", "critical"] as const;

export type IntegrationActivitySeverity = (typeof INTEGRATION_ACTIVITY_SEVERITIES)[number];

export const integrationActivitySeveritySchema = z.enum(INTEGRATION_ACTIVITY_SEVERITIES);

export type IntegrationActivityRollup = z.infer<typeof integrationActivityRollupSchema>;

export type IntegrationActivityItem = z.infer<typeof integrationActivityItemSchema>;

export type IntegrationActivityContribution = z.infer<typeof integrationActivityContributionSchema>;

export const weatherContributionSchema = z.object({
  current: z.object({
    temperatureC: z.number(),
    apparentTemperatureC: z.number(),
    description: z.string(),
  }),
  forecast: z.object({
    highC: z.number(),
    lowC: z.number(),
    precipitationMm: z.number(),
    description: z.string(),
  }),
});

export type WeatherContribution = z.infer<typeof weatherContributionSchema>;

export const dayOfWeekContributionSchema = z.object({
  dayName: z.string(),
  isWeekend: z.boolean(),
  holiday: z.object({ name: z.string(), locale: z.string() }).optional(),
});

export type DayOfWeekContribution = z.infer<typeof dayOfWeekContributionSchema>;

// ─── Day-shape (ADR-0064 / #230) ──────────────────────────────────────────
// How busy the day was, from counts, so the composer does not call a busy day "quiet".

export const DAY_SHAPE_VOLUMES = ["busy", "normal", "quiet"] as const;

export type DayShapeVolume = (typeof DAY_SHAPE_VOLUMES)[number];

export const dayShapeVolumeSchema = z.enum(DAY_SHAPE_VOLUMES);

/** The `shipped` title bound. Every producer of a `shipped` title clips to this value. */
export const DAY_SHAPE_TITLE_MAX = 300;

export const dayShapeSchema = z.object({
  activityVolume: dayShapeVolumeSchema,
  /** Work that shipped or resolved, for the evening recap. */
  shipped: z.array(
    z.object({ title: z.string().min(1).max(DAY_SHAPE_TITLE_MAX), url: z.url().optional() }),
  ),
  /** Merges in the window when a live read counted them. `shipped` holds only the newest few. */
  shippedTotal: z.number().int().nonnegative().optional(),
  /**
   * Priority emails in the `demanding` band. With no activity and no events, zero
   * suppresses the morning briefing (#259). Absent on old rows and without email
   * context; the gate then uses the raw email count (ADR-0048).
   */
  demandingEmailCount: z.number().int().nonnegative().optional(),
  /** Highest email band (`muted` when none), so a suppressed morning can log why. */
  topEmailBand: attentionBandSchema.optional(),
});

export type DayShape = z.infer<typeof dayShapeSchema>;

/**
 * A priority email dropped because the object projection proved its loop closed.
 * Stored apart from `gather` so a replay can inspect the closure facts.
 */
export const briefingClosedLoopSchema = z.object({
  documentId: z.string().min(1),
  category: triageCategorySchema,
  subject: z.string().nullable(),
  objectTitle: z.string().nullable(),
  objectUrl: z.url().nullable(),
  stateCategory: z.enum(LOOP_CLOSING_STATE_CATEGORIES),
  nativeState: z.string().nullable(),
});

export type BriefingClosedLoop = z.infer<typeof briefingClosedLoopSchema>;

/**
 * Check-before-remind verdicts (#1194), one per live loop. They change phrasing
 * and priority only, never closure: only the object-state store closes a loop
 * (ADR-0048-D, ADR-0103). That is why no verdict means "closed".
 */
export const LOOP_RELEVANCE_VERDICTS = [
  "still-actionable",
  "stale-but-open",
  "unverifiable",
] as const;

export type LoopRelevanceVerdict = (typeof LOOP_RELEVANCE_VERDICTS)[number];

export const loopRelevanceVerdictSchema = z.enum(LOOP_RELEVANCE_VERDICTS);

/** The live read behind the verdict. `none`: no live read was available. */
export const LOOP_RELEVANCE_SOURCES = [
  "live_github_read",
  "live_railway_read",
  "live_mcp_read",
  "none",
] as const;

export type LoopRelevanceSource = (typeof LOOP_RELEVANCE_SOURCES)[number];

export const loopRelevanceSourceSchema = z.enum(LOOP_RELEVANCE_SOURCES);

/** Provider titles have no length limit at ingest. */
export const BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX = 300;

export const briefingLoopRelevanceSchema = z.object({
  documentId: z.string().min(1),
  verdict: loopRelevanceVerdictSchema,
  source: loopRelevanceSourceSchema,
  /** The provider state token (`open`, `merged`). It shapes phrasing; it never closes a loop. */
  observedState: z.string().max(80).nullable(),
  objectTitle: z.string().max(BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX).nullable(),
  objectUrl: z.url().nullable(),
  /** One line of cited evidence for the composer. */
  detail: z.string().min(1).max(300),
});

export type BriefingLoopRelevance = z.infer<typeof briefingLoopRelevanceSchema>;

/**
 * `email`, `day_of_week`, and `integration_activity` are always present (empty, not
 * `null`). `calendar` and `weather` are `null` when unavailable, which is not an error.
 */
export type BriefingGather = z.infer<typeof briefingGatherSchema>;

// ─── Full briefing (composer + persisted output structure) ────────────────

export type FullBriefingSection = z.infer<typeof fullBriefingSectionSchema>;

export type BriefingSourcePanelItem = z.infer<typeof briefingSourcePanelItemSchema>;

export type BriefingSourcePanel = z.infer<typeof briefingSourcePanelSchema>;

export type ComposerFullBriefing = BriefingComposerOutput["fullBriefing"];

export type FullBriefing = z.infer<typeof fullBriefingSchema>;

export const integrationSlugSchema = z.string().refine(isIntegrationSlug, {
  message: "Expected a known integration slug",
});

export const integrationActivityRollupSchema = z.object({
  eventCount: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative().optional(),
  durationMinutes: z.number().nonnegative().optional(),
  suppressedEventIds: z.array(z.string().min(1)).optional(),
});

/**
 * The activity line title bound. Every producer of an activity line clips to this value: the
 * activity record lines (`activityItemsOf`) and each verified-pull source (`toActivityItem`).
 */
export const INTEGRATION_ACTIVITY_TITLE_MAX = 300;

export const integrationActivityItemSchema = z.object({
  id: z.string().min(1),
  provider: integrationSlugSchema,
  source: integrationActivitySourceSchema,
  activityCategory: integrationActivityCategorySchema,
  providerKind: z.string().min(1).max(120),
  title: z.string().min(1).max(INTEGRATION_ACTIVITY_TITLE_MAX),
  status: integrationActivityStatusSchema.optional(),
  severity: integrationActivitySeveritySchema.optional(),
  occurredAt: z.string().min(1),
  url: z.url().optional(),
  relatedRepo: z.string().min(1).optional(),
  rollup: integrationActivityRollupSchema.optional(),
});

export const integrationActivityContributionSchema = z.object({
  items: z.array(integrationActivityItemSchema),
});

// ─── Input provenance (ADR-0117 decision 1) ──────────────────────────────

/** Each input that the gather reads. A new input adds a member and states its blind state. */
export const GATHER_INPUTS = [
  "email",
  "calendar",
  "weather",
  "integration_activity",
  "github_merged",
  "loop_relevance",
  "official_warnings",
] as const;

export type GatherInput = (typeof GATHER_INPUTS)[number];

export const gatherInputSchema = z.enum(GATHER_INPUTS);

const connectRecoverySchema = z.object({
  kind: z.literal("connect"),
  integration: z.enum(LIVE_PROVIDER_SLUGS),
});

const retryRecoverySchema = z.object({ kind: z.literal("retry") });

const noRecoverySchema = z.object({ kind: z.literal("none") });

/** Bound on a provenance sentence. It is a fact for the composer and the log, not copy. */
export const GATHER_PROVENANCE_TEXT_MAX = 300;

const provenanceTextSchema = z.string().min(1).max(GATHER_PROVENANCE_TEXT_MAX);

/**
 * Why Alfred could not read an input. Each cause pins the recovery that it allows, so a wrong
 * pair does not compile. Three causes ask the user to act, with recovery `connect`:
 * `scope_missing` (the account is connected without the grant for this input), `needs_reauth`
 * (a credential row exists, but no row is active), and `not_delivered` (the provider's events do
 * not reach Alfred, ADR-0118 decision 4). `not_connected` has recovery `none`, because no
 * credential row is also what a deliberate disconnect leaves (ADR-0100 amendment 2026-10-28,
 * item 3). Two activity-record causes have recovery `none`: `silent` (no delivery for longer than
 * the source's bound, and Alfred could not confirm that the source had nothing to send) and
 * `record_incomplete` (a delivery arrived, but the record does not hold its act).
 */
const unavailableProvenanceSchema = z.discriminatedUnion("cause", [
  z.object({
    input: gatherInputSchema,
    state: z.literal("unavailable"),
    cause: z.enum(["scope_missing", "needs_reauth", "not_delivered"]),
    reason: provenanceTextSchema,
    recovery: connectRecoverySchema,
  }),
  z.object({
    input: gatherInputSchema,
    state: z.literal("unavailable"),
    cause: z.literal("read_failed"),
    reason: provenanceTextSchema,
    recovery: retryRecoverySchema,
  }),
  z.object({
    input: gatherInputSchema,
    state: z.literal("unavailable"),
    cause: z.enum(["not_connected", "no_place", "silent", "record_incomplete"]),
    reason: provenanceTextSchema,
    recovery: noRecoverySchema,
  }),
]);

/**
 * The provenance of one gather input, or of one item in it (ADR-0117 decision 1).
 *
 * - `live`: Alfred read the real source for this user, in this window.
 * - `fallback`: Alfred used a default in place of a user fact. `used` names the default. No
 *   surface can set the replaced fact yet, so the recovery is `none` and the entry is a log line.
 * - `stale`: one item is real but older than the window. The item leaves the news list.
 * - `unavailable`: Alfred could not read the input. The cause pins the recovery.
 */
export const gatherProvenanceSchema = z.union([
  z.object({ input: gatherInputSchema, state: z.literal("live") }),
  z.object({
    input: gatherInputSchema,
    state: z.literal("fallback"),
    used: provenanceTextSchema,
    reason: provenanceTextSchema,
    recovery: noRecoverySchema,
  }),
  z.object({
    input: gatherInputSchema,
    state: z.literal("stale"),
    // The stale item is an activity item, so its title bound is the activity title's bound.
    title: integrationActivityItemSchema.shape.title,
    occurredAt: z.string().min(1),
    recovery: noRecoverySchema,
  }),
  unavailableProvenanceSchema,
]);

export type GatherProvenance = z.infer<typeof gatherProvenanceSchema>;

/**
 * An entry whose recovery is `connect`: the shape that a connection-block row needs. The briefing
 * decides which entries become rows (`provenanceAudience` in `@alfred/assistant`).
 */
export type BlockingGatherProvenance = Extract<
  GatherProvenance,
  { state: "unavailable"; recovery: { kind: "connect" } }
>;

/**
 * Upper bound on the stale entries that one gather stores. The producer keeps the first entries up
 * to this bound and logs the count that it drops.
 */
export const GATHER_STALE_PROVENANCE_MAX = 10;

/**
 * Upper bound on stored entries. Today a gather states at most two entries for each input (weather:
 * a failed read and its fallback; warnings: a place entry and a failed read), which is 14 for
 * seven inputs, plus the stale entries above (10).
 * The verified pull reads at most 5 targets for each of its 2 providers, so 10 stale entries is
 * also the most it can produce. The producer clips the list to this bound, so a stored list never
 * fails its parse on length.
 */
export const GATHER_PROVENANCE_MAX = GATHER_INPUTS.length * 2 + GATHER_STALE_PROVENANCE_MAX;

// ─── Official warnings (ADR-0117 decision 4) ─────────────────────────────

/** The official feeds that the gather reads. GDACS is global; NDMA Sachet is India's CAP feed. */
export const OFFICIAL_WARNING_SOURCES = ["gdacs", "ndma_sachet"] as const;

export type OfficialWarningSource = (typeof OFFICIAL_WARNING_SOURCES)[number];

/** Most warnings that one gather stores. The producer keeps the most severe ones. */
export const OFFICIAL_WARNINGS_MAX = 8;

/**
 * Text bounds of one warning. The producer clips each field to its bound and parses the warning
 * before it stores it, so a feed value cannot fail the parse of the stored gather.
 */
export const OFFICIAL_WARNING_TEXT_MAX = {
  issuer: 120,
  event: 200,
  severity: 40,
  headline: 500,
  area: 300,
} as const;

/**
 * One official warning whose area contains the user's place on the briefing day. A geometry or
 * district match selects it, not a model. `severity` is the feed's own word: a CAP severity
 * ("Severe") or a GDACS alert level ("Red alert"). `onset` and `expires` are UTC instants in the
 * `Date.prototype.toISOString` form ("2026-11-01T00:00:00.000Z"), so their text order is their time
 * order.
 */
export const officialWarningSchema = z.object({
  source: z.enum(OFFICIAL_WARNING_SOURCES),
  issuer: z.string().min(1).max(OFFICIAL_WARNING_TEXT_MAX.issuer),
  event: z.string().min(1).max(OFFICIAL_WARNING_TEXT_MAX.event),
  severity: z.string().min(1).max(OFFICIAL_WARNING_TEXT_MAX.severity),
  headline: z.string().min(1).max(OFFICIAL_WARNING_TEXT_MAX.headline),
  area: z.string().min(1).max(OFFICIAL_WARNING_TEXT_MAX.area),
  onset: z.iso.datetime({ precision: 3 }),
  expires: z.iso.datetime({ precision: 3 }),
  url: z.url().optional(),
});

export type OfficialWarning = z.infer<typeof officialWarningSchema>;

/**
 * The warnings for one place, from at least one feed that Alfred read. An empty `items` list says
 * that those feeds had no warning, not that no hazard exists. The provenance names the feeds that
 * Alfred could not read.
 */
export const officialWarningsContributionSchema = z.object({
  items: z.array(officialWarningSchema).max(OFFICIAL_WARNINGS_MAX),
});

export type OfficialWarningsContribution = z.infer<typeof officialWarningsContributionSchema>;

export const briefingGatherSchema = z.object({
  email: emailContributionSchema,
  calendar: calendarContributionSchema.nullable(),
  integration_activity: integrationActivityContributionSchema,
  weather: weatherContributionSchema.nullable(),
  /**
   * Official warnings at the user's place (ADR-0117 decision 4). `null`: no feed was read, and the
   * provenance says why. Optional, so a gather from before this field parses.
   */
  official_warnings: officialWarningsContributionSchema.nullable().optional(),
  day_of_week: dayOfWeekContributionSchema,
  /** Optional, so older gathers parse. Absence is not an error. */
  day_shape: dayShapeSchema.optional(),
  /**
   * Connections whose delivery broke and that the user can repair (ADR-0100 amendment
   * 2026-10-28). A delivery fact, not proof that the gathered data is missing: a lapsed Gmail
   * watch still has the history poll. Optional, so older gathers parse. Absent reads as none.
   */
  broken_connections: z.array(deliveryAlertSchema).optional(),
  /** MCP connections the user must repair (item 4 of the same amendment). Optional for the same reason. */
  broken_mcp_connections: z.array(mcpConnectionAlertSchema).optional(),
  /**
   * The provenance of each input (ADR-0117 decision 1). Optional, so a gather from before this
   * field parses. Such a gather states nothing, and every reader treats absence as no statements.
   */
  provenance: z.array(gatherProvenanceSchema).max(GATHER_PROVENANCE_MAX).optional(),
});

export const fullBriefingSectionSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  body: z.string().min(1).max(2000),
  /** Shown to the user. Not raw model reasoning. */
  why: z.string().min(1).max(500).optional(),
  references: z.array(z.string().min(1)).max(12).optional(),
});

/** Composer output (ADR-0041). The bounds stop runaway output. */
export const briefingComposerSchema = z.object({
  breakingSummary: z.string().min(1).max(2000),
  fullBriefing: z.object({
    headline: z.string().min(1).max(200),
    sections: z.array(fullBriefingSectionSchema).max(12),
    auditSummary: z.string().min(1).max(2000).optional(),
  }),
});

export type BriefingComposerOutput = z.infer<typeof briefingComposerSchema>;

export const briefingSourcePanelItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  status: z.string().max(80).optional(),
  severity: integrationActivitySeveritySchema.optional(),
  href: z.url().optional(),
  reference: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const briefingSourcePanelSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  items: z.array(briefingSourcePanelItemSchema).max(50),
});

/** Bound on one notice the composer writes about a broken connection. */
export const BRIEFING_CONNECTION_NOTICE_MAX = 600;

/**
 * The composer's words about one broken connection (ADR-0100 amendment 2026-10-28). `key` names
 * the connection the gather listed; the send step adds the name and the repair link, and shows a
 * bare row for a key with no notice.
 */
export const briefingConnectionNoticeSchema = z.object({
  key: z.string().min(1),
  text: z.string().min(1).max(BRIEFING_CONNECTION_NOTICE_MAX),
});

export type BriefingConnectionNotice = z.infer<typeof briefingConnectionNoticeSchema>;

export const fullBriefingSchema = briefingComposerSchema.shape.fullBriefing.extend({
  /** Built after compose, never by the model. */
  sourcePanels: z.array(briefingSourcePanelSchema).max(8).optional(),
  /** Emails the prose actually cited. The next briefing reads this, not the whole gather. */
  surfacedDocumentIds: z.array(z.string().min(1)).max(100).optional(),
  /** The composer's notices for the broken connections, so a resumed send reuses them. */
  connectionNotices: z.array(briefingConnectionNoticeSchema).max(50).optional(),
});

// ─── Contributor contract ─────────────────────────────────────────────────

export interface BriefingContributor<T> {
  source: GatherSourceSlug;
  collect(args: {
    userId: string;
    /** YYYY-MM-DD in the user's zone. */
    date: string;
    timezone: IanaTimezone;
  }): Promise<T | null>;
}

// ─── Slot + status machine ────────────────────────────────────────────────

export const briefingSlotValues = ["morning", "evening"] as const;

export type BriefingSlot = (typeof briefingSlotValues)[number];

export const briefingSlotSchema = z.enum(briefingSlotValues);

export const briefingSendDecisionValues = ["sent", "suppressed"] as const;

export type BriefingSendDecision = (typeof briefingSendDecisionValues)[number];

export const briefingSendDecisionSchema = z.enum(briefingSendDecisionValues);

export const briefingStatusValues = [
  "pending",
  "gathering",
  "composing",
  "composed",
  "sent",
  "suppressed",
  "failed",
] as const;

export type BriefingStatus = (typeof briefingStatusValues)[number];

export const briefingStatusSchema = z.enum(briefingStatusValues);

export { triageCategorySchema };
