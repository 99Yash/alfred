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

// ─── Sources + reference kinds ────────────────────────────────────────────

export const GATHER_SOURCE_SLUGS = [
  "email",
  "calendar",
  "github",
  "weather",
  "day_of_week",
] as const;
export type GatherSourceSlug = (typeof GATHER_SOURCE_SLUGS)[number];

export const gatherSourceSlugSchema = z.enum(GATHER_SOURCE_SLUGS);

export const BRIEFING_REFERENCE_KINDS = [
  "pr",
  "commit",
  "meeting",
  "email",
  "repo",
] as const;
export type BriefingReferenceKind = (typeof BRIEFING_REFERENCE_KINDS)[number];

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

export interface GithubContribution {
  prsAwaitingReview: Array<{
    repo: string;
    number: number;
    title: string;
    author: string;
    url: string;
  }>;
  commitsYesterday: Array<{
    repo: string;
    sha: string;
    shortSha: string;
    message: string;
    url: string;
  }>;
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
 *   - `calendar` / `github` / `weather` are `null` when "not connected / scope
 *     missing / upstream failed". The composer prompt handles the empty case
 *     verbatim — empty state is content, not an error path.
 */
export interface BriefingGather {
  email: EmailContribution;
  calendar: CalendarContribution | null;
  github: GithubContribution | null;
  weather: WeatherContribution | null;
  day_of_week: DayOfWeekContribution;
}

// ─── Full briefing (composer output structure) ────────────────────────────

export interface FullBriefingSection {
  source: GatherSourceSlug;
  label: string;
  body: string;
}

export interface FullBriefing {
  headline: string;
  sections: FullBriefingSection[];
  reasoning: string;
}

/**
 * Composer structured-output schema (ADR-0041 §"Composer output schema").
 * Bounds prevent runaway output; `sections` capped at 12 to match the closed
 * source enum + small slop for future expansion.
 */
export const briefingSchema = z.object({
  breakingSummary: z.string().min(1).max(2000),
  fullBriefing: z.object({
    headline: z.string().min(1).max(200),
    sections: z
      .array(
        z.object({
          source: gatherSourceSlugSchema,
          label: z.string().min(1).max(80),
          body: z.string().min(1).max(2000),
        }),
      )
      .max(12),
    reasoning: z.string().min(1).max(3000),
  }),
});

export type BriefingComposerOutput = z.infer<typeof briefingSchema>;

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
