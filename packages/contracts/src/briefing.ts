/**
 * Daily-briefing contract (ADR-0041). Zero Node deps — safe to import from
 * `apps/web`, `packages/db` (`.$type<T>()` columns), `packages/assistant`, and
 * `packages/sync`. The composer's structured-output schema, the per-source
 * gather shape, the reference-kind enum, and the closed timezone-fallback
 * surface all live here so the briefings table column types and the
 * Replicache read schema agree by construction.
 */

import { z } from "zod";

import { attentionBandSchema } from "./attention";
import { triageCategorySchema } from "./triage";
import { isIntegrationSlug, type IntegrationSlug } from "./integrations";

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

/**
 * Cached at module scope — `Intl.supportedValuesOf('timeZone')` allocates
 * a ~600-entry array on every call. Guard / schema-refine both run on hot
 * paths (API boundaries, zod parsing), so we pay the allocation once.
 *
 * Mutable (not Readonly) so {@link isSupportedTimezone} can memoize the
 * runtime-trial hits below.
 */
const SUPPORTED_TIMEZONES: Set<string> = new Set(Intl.supportedValuesOf("timeZone"));

/**
 * Whether the runtime can resolve `value` as a timezone.
 *
 * `Intl.supportedValuesOf('timeZone')` lists only canonical *region* zones —
 * it omits valid aliases like "UTC" and "Etc/UTC" that `Intl.DateTimeFormat`
 * accepts. (This is exactly the gap that broke briefings: the default
 * `"UTC"` pref passed `DateTimeFormat`-based validation in `@alfred/assistant` but
 * failed the set-membership check here, throwing in every briefing `gather`.)
 *
 * So the set is the fast path and a `DateTimeFormat` trial is the fallback;
 * a successful trial is memoized into the set, keeping repeat lookups O(1).
 */
function isSupportedTimezone(value: string): boolean {
  if (SUPPORTED_TIMEZONES.has(value)) return true;
  try {
    // Throws RangeError on an unknown zone; succeeds for valid aliases.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    SUPPORTED_TIMEZONES.add(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime guard for IANA timezone strings. Verifies the value against the
 * platform's supported timezones so we don't accept arbitrary text. Throws
 * on miss so callers can rely on the branded type after the call.
 */
export function assertIanaTimezone(value: string): asserts value is IanaTimezone {
  if (!isSupportedTimezone(value)) {
    throw new Error(`Not a recognized IANA timezone: ${value}`);
  }
}

/**
 * Parse a string into a branded {@link IanaTimezone}, or throw.
 *
 * The expression form of {@link assertIanaTimezone}, for the boundaries that
 * read a zone back out of persisted state or a workflow payload and need it as
 * a value. Two identical private copies of this existed before it did.
 */
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
  .refine(isIanaTimezone, { message: "Expected an IANA timezone identifier" })
  .transform((value) => {
    // SAFETY: the refine above ran isIanaTimezone, which is exactly what the
    // IanaTimezone brand certifies; this mints the branded alias of a proven
    // string (the standard parse-then-brand idiom).
    return value as IanaTimezone;
  });

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

export const INTEGRATION_ACTIVITY_SOURCES = ["direct_api", "email_triage"] as const;
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
// A deterministic read of how busy the day actually was, so the composer never
// characterizes a day with real shipping/activity as "quiet" (the inverse of
// #210's over-tagging — presentation not reflecting reality). Sourced from the
// object-state projection (ADR-0062) + the integration-activity window count;
// no LLM judgment.

export const DAY_SHAPE_VOLUMES = ["busy", "normal", "quiet"] as const;
export type DayShapeVolume = (typeof DAY_SHAPE_VOLUMES)[number];
export const dayShapeVolumeSchema = z.enum(DAY_SHAPE_VOLUMES);

export const dayShapeSchema = z.object({
  /** Activity intensity over the window — derived from deterministic counts. */
  activityVolume: dayShapeVolumeSchema,
  /** Work objects that reached a shipped/resolved state — the evening recap. */
  shipped: z.array(
    z.object({ title: z.string().min(1).max(300), url: z.string().url().optional() }),
  ),
  /**
   * Count of gathered priority emails scored at the `demanding` attention band
   * (ADR-0064). The morning suppression gate (#259) reads this: a cron morning
   * with zero demanding email, no integration activity, and no calendar events
   * is a genuinely quiet day and suppresses — a normal/muted item (a resolved
   * micro-charge, a cold recruiter ask) no longer forces a send and promotes
   * itself to the headline. Actionable payment failures/bills are pinned into
   * this count by the gather scorer. Optional + additive: absent on day-shape
   * objects persisted before this field, and on a standalone `gatherDayShape()`
   * call that has no email context — the gate treats absence as "signal
   * unavailable" and falls back to the raw email count (errs toward sending,
   * ADR-0048).
   */
  demandingEmailCount: z.number().int().nonnegative().optional(),
  /**
   * Highest attention band among the gathered priority emails (`muted` when
   * there are none). Presentation/logging aid — lets a suppressed morning's log
   * line say *why* it was quiet. Same optionality as `demandingEmailCount`.
   */
  topEmailBand: attentionBandSchema.optional(),
});

export type DayShape = z.infer<typeof dayShapeSchema>;

/**
 * Output of the gather step. Sources split into guaranteed vs optional:
 *   - `email` is always present — triage is a built-in pipeline; an empty
 *     inbox is represented as `categories: {}`, not `null`.
 *   - `day_of_week` is always present — it's deterministic from the briefing
 *     date and never fails.
 *   - `integration_activity` is always present — no connected producers is
 *     represented as `items: []`, not `null`.
 *   - `calendar` / `weather` are `null` when "not connected / scope missing /
 *     upstream failed". The composer prompt handles the empty case verbatim —
 *     empty state is content, not an error path.
 */
export type BriefingGather = z.infer<typeof briefingGatherSchema>;

// ─── Full briefing (composer + persisted output structure) ────────────────

export type FullBriefingSection = z.infer<typeof fullBriefingSectionSchema>;

export type BriefingSourcePanelItem = z.infer<typeof briefingSourcePanelItemSchema>;

export type BriefingSourcePanel = z.infer<typeof briefingSourcePanelSchema>;

export type ComposerFullBriefing = BriefingComposerOutput["fullBriefing"];

export type FullBriefing = z.infer<typeof fullBriefingSchema>;

/**
 * Composer structured-output schema (ADR-0041 §"Composer output schema").
 * Bounds prevent runaway output; `sections` capped at 12 to match the closed
 * source enum + small slop for future expansion.
 */
export const integrationSlugSchema = z
  .string()
  .refine(isIntegrationSlug, {
    message: "Expected a known integration slug",
  })
  .transform((value) => {
    // SAFETY: the refine above ran isIntegrationSlug, which is exactly what
    // the IntegrationSlug union certifies; this mints the branded alias of a
    // proven string.
    return value as IntegrationSlug;
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
  url: z.string().url().optional(),
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
  /**
   * Deterministic day-shape signal (ADR-0064 / #230). Optional + additive so
   * gather payloads persisted before this field parse unchanged; the composer
   * treats its absence as "no day-shape signal," never an error.
   */
  day_shape: dayShapeSchema.optional(),
});

export const fullBriefingSectionSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  body: z.string().min(1).max(2000),
  /** User-facing inclusion rationale, not raw model reasoning. */
  why: z.string().min(1).max(500).optional(),
  /** Reference ids used in this section, e.g. `activity:...`. */
  references: z.array(z.string().min(1)).max(12).optional(),
});

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
  href: z.string().url().optional(),
  reference: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const briefingSourcePanelSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  items: z.array(briefingSourcePanelItemSchema).max(50),
});

export const fullBriefingSchema = briefingComposerSchema.shape.fullBriefing.extend({
  /** Deterministic display panels generated after compose; never model-authored. */
  sourcePanels: z.array(briefingSourcePanelSchema).max(8).optional(),
  /**
   * Email document ids the delivered prose actually referenced. This is audit /
   * continuity state, not display content: the next briefing uses it to decide
   * what the user was truly told about, instead of treating every gathered item
   * as surfaced.
   */
  surfacedDocumentIds: z.array(z.string().min(1)).max(100).optional(),
});

// ─── Contributor contract ─────────────────────────────────────────────────

export interface BriefingContributor<T> {
  source: GatherSourceSlug;
  collect(args: {
    userId: string;
    /** YYYY-MM-DD calendar date in the user's timezone. */
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

// Re-export the triage schema dependency so downstream consumers don't
// need a second import for the shared category enum.
export { triageCategorySchema };
