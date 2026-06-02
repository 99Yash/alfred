/**
 * Daily-briefing contract (ADR-0041). Zero Node deps — safe to import from
 * `apps/web`, `packages/db` (`.$type<T>()` columns), `packages/api`, and
 * `packages/sync`. The composer's structured-output schema, the per-source
 * gather shape, the reference-kind enum, and the closed timezone-fallback
 * surface all live here so the briefings table column types and the
 * Replicache read schema agree by construction.
 */

import { z } from "zod";

import { triageCategorySchema, type TriageCategory } from "./triage.js";
import { isIntegrationSlug, type IntegrationSlug } from "./tools.js";

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
 */
const SUPPORTED_TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("timeZone"));

/**
 * Runtime guard for IANA timezone strings. Verifies the value against the
 * platform's supported timezones so we don't accept arbitrary text. Throws
 * on miss so callers can rely on the branded type after the call.
 */
export function assertIanaTimezone(value: string): asserts value is IanaTimezone {
  if (!SUPPORTED_TIMEZONES.has(value)) {
    throw new Error(`Not a recognized IANA timezone: ${value}`);
  }
}

export function isIanaTimezone(value: unknown): value is IanaTimezone {
  if (typeof value !== "string") return false;
  return SUPPORTED_TIMEZONES.has(value);
}

export const ianaTimezoneSchema = z
  .string()
  .refine(isIanaTimezone, { message: "Expected an IANA timezone identifier" })
  .transform((value) => value as IanaTimezone);

// ─── Per-source contribution shapes ───────────────────────────────────────

export interface EmailContribution {
  categories: Partial<
    Record<
      TriageCategory,
      Array<{
        documentId: string;
        threadId: string;
        subject: string;
        sender: string;
        snippet: string;
      }>
    >
  >;
}

export interface CalendarContribution {
  events: Array<{
    eventId: string;
    title: string;
    start: string;
    end: string;
    attendees: string[];
    location?: string;
  }>;
}

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

export interface IntegrationActivityRollup {
  eventCount: number;
  attemptCount?: number;
  durationMinutes?: number;
  suppressedEventIds?: string[];
}

export interface IntegrationActivityItem {
  id: string;
  provider: IntegrationSlug;
  source: IntegrationActivitySource;
  activityCategory: IntegrationActivityCategory;
  /** Provider-scoped detail, e.g. `github.pr_review_requested`. */
  providerKind: string;
  title: string;
  status?: IntegrationActivityStatus;
  severity?: IntegrationActivitySeverity;
  occurredAt: string;
  url?: string;
  relatedRepo?: string;
  rollup?: IntegrationActivityRollup;
}

export interface IntegrationActivityContribution {
  items: IntegrationActivityItem[];
}

export interface WeatherContribution {
  current: {
    temperatureC: number;
    apparentTemperatureC: number;
    description: string;
  };
  forecast: {
    highC: number;
    lowC: number;
    precipitationMm: number;
    description: string;
  };
}

export interface DayOfWeekContribution {
  dayName: string;
  isWeekend: boolean;
  holiday?: { name: string; locale: string };
}

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
export interface BriefingGather {
  email: EmailContribution;
  calendar: CalendarContribution | null;
  integration_activity: IntegrationActivityContribution;
  weather: WeatherContribution | null;
  day_of_week: DayOfWeekContribution;
}

// ─── Full briefing (composer + persisted output structure) ────────────────

export interface FullBriefingSection {
  source: GatherSourceSlug;
  label: string;
  body: string;
  /** User-facing inclusion rationale, not raw model reasoning. */
  why?: string;
  /** Reference ids used in this section, e.g. `activity:...`. */
  references?: string[];
}

export interface BriefingSourcePanelItem {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  severity?: IntegrationActivitySeverity;
  href?: string;
  reference?: string;
  metadata?: Record<string, string>;
}

export interface BriefingSourcePanel {
  source: GatherSourceSlug;
  label: string;
  items: BriefingSourcePanelItem[];
}

export interface ComposerFullBriefing {
  headline: string;
  sections: FullBriefingSection[];
  auditSummary?: string;
}

export interface FullBriefing extends ComposerFullBriefing {
  /** Deterministic display panels generated after compose; never model-authored. */
  sourcePanels?: BriefingSourcePanel[];
}

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
  .transform((value) => value as IntegrationSlug);

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

export const fullBriefingSectionSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  body: z.string().min(1).max(2000),
  why: z.string().min(1).max(500).optional(),
  references: z.array(z.string().min(1)).max(12).optional(),
}) satisfies z.ZodType<FullBriefingSection>;

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
}) satisfies z.ZodType<BriefingSourcePanelItem>;

export const briefingSourcePanelSchema = z.object({
  source: gatherSourceSlugSchema,
  label: z.string().min(1).max(80),
  items: z.array(briefingSourcePanelItemSchema).max(50),
}) satisfies z.ZodType<BriefingSourcePanel>;

export const fullBriefingSchema = briefingComposerSchema.shape.fullBriefing.extend({
  sourcePanels: z.array(briefingSourcePanelSchema).max(8).optional(),
}) satisfies z.ZodType<FullBriefing>;

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

// ─── Status machine ───────────────────────────────────────────────────────

export const briefingStatusValues = [
  "pending",
  "gathering",
  "composing",
  "sent",
  "failed",
] as const;
export type BriefingStatus = (typeof briefingStatusValues)[number];

export const briefingStatusSchema = z.enum(briefingStatusValues);

// Re-export the triage schema dependency so downstream consumers don't
// need a second import for the shared category enum.
export { triageCategorySchema };
