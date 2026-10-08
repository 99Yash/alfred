/** Daily-briefing contract (ADR-0041), shared by the DB columns, sync, and the web. */

import { z } from "zod";

import { attentionBandSchema } from "./attention";
import { LOOP_CLOSING_STATE_CATEGORIES } from "./integration-objects";
import { triageCategorySchema } from "./triage";
import { isIntegrationSlug } from "./integrations";

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

export const ianaTimezoneSchema = z
  .string()
  .refine(isIanaTimezone, { message: "Expected an IANA timezone identifier" });

// ─── Per-source contribution shapes ───────────────────────────────────────

const emailContributionItemSchema = z.object({
  documentId: z.string().min(1),
  threadId: z.string(),
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

export const dayShapeSchema = z.object({
  activityVolume: dayShapeVolumeSchema,
  /** Work that shipped or resolved, for the evening recap. */
  shipped: z.array(z.object({ title: z.string().min(1).max(300), url: z.url().optional() })),
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
  "live_sentry_read",
  "live_github_read",
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

export const integrationActivityItemSchema = z.object({
  id: z.string().min(1),
  provider: integrationSlugSchema,
  source: integrationActivitySourceSchema,
  activityCategory: integrationActivityCategorySchema,
  providerKind: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
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

export const briefingGatherSchema = z.object({
  email: emailContributionSchema,
  calendar: calendarContributionSchema.nullable(),
  integration_activity: integrationActivityContributionSchema,
  weather: weatherContributionSchema.nullable(),
  day_of_week: dayOfWeekContributionSchema,
  /** Optional, so older gathers parse. Absence is not an error. */
  day_shape: dayShapeSchema.optional(),
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

export const fullBriefingSchema = briefingComposerSchema.shape.fullBriefing.extend({
  /** Built after compose, never by the model. */
  sourcePanels: z.array(briefingSourcePanelSchema).max(8).optional(),
  /** Emails the prose actually cited. The next briefing reads this, not the whole gather. */
  surfacedDocumentIds: z.array(z.string().min(1)).max(100).optional(),
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
