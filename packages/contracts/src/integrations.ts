/**
 * The integration registry (ADR-0093): one record per integration, keyed by
 * the slug, and every per-integration fact read off that record.
 *
 * Before this file an integration's facts lived in more than 40 tables across
 * five packages, each exhaustive on its own (`satisfies Record<Slug, …>`) while
 * the *set* of tables stayed open, so three web tables shipped without
 * `notion`/`railway`/`vercel` rows. Here the set is closed: a new integration
 * is one new entry in {@link INTEGRATIONS}, and the compiler lists every
 * sibling that needs a row. Everything else keyed by an integration is one of:
 *
 *  1. a **projection** of the record (`INTEGRATION_DISPLAY_NAMES`), derived in
 *     code and never hand-typed;
 *  2. an **exhaustive sibling** keyed by a union derived here
 *     (`satisfies Record<LiveProviderSlug, T>`), so a missing row is a compile
 *     error; or
 *  3. a **web asset** keyed by the `brand` key an entry owns.
 *
 * This file imports only `./guards` and `./google-scopes`: `./tools` reads the
 * display-name projection for `integrationDisplayName`, so the slug tuple lives
 * here rather than there to keep the module graph acyclic.
 */

import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  GMAIL_READONLY_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
  type GoogleFeature,
  type GoogleScope,
} from "./google-scopes";
import { enumGuard } from "./guards";

// ---------------------------------------------------------------------------
// The id space. The one primitive: the record below `satisfies` a `Record` over
// this tuple, so it cannot also define the slug list.
// ---------------------------------------------------------------------------

export const INTEGRATION_SLUGS = [
  "system",
  "mcp",
  "gmail",
  "calendar",
  "drive",
  "docs",
  "sheets",
  "slides",
  "slack",
  "linear",
  "github",
  "notion",
  "railway",
  "vercel",
  "imessage",
] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export const isIntegrationSlug = enumGuard(INTEGRATION_SLUGS);

// ---------------------------------------------------------------------------
// Entry shape. `kind` decides the shape; `status` exists only on a provider.
// A planned or non-provider entry has no credential and no passthrough because
// its type has no such field — not because a table says `deferred`.
// ---------------------------------------------------------------------------

interface EntryBase {
  /** Display name for prose a user or the model reads. */
  readonly displayName: string;
}

/** Alfred's own tools (`system`) and the MCP projection (`mcp`, ADR-0018). */
export interface InternalIntegrationEntry extends EntryBase {
  readonly kind: "internal";
}

/** A local ingest channel with no provider credential (iMessage). */
export interface ChannelIntegrationEntry extends EntryBase {
  readonly kind: "channel";
}

/** A provider that has a page and a brand but no wired credential store yet. */
export interface PlannedIntegrationEntry extends EntryBase {
  readonly kind: "provider";
  readonly status: "planned";
  /** Web asset key (icon, accent); the web owns the asset. */
  readonly brand: string;
}

/**
 * How a live provider's credential is stored and how "connected" is proved.
 *
 * `provider` is the value in `integration_credentials.provider` and the route
 * family `/api/integrations/<provider>/...`. They are one field on purpose: no
 * code treats them differently. If they ever diverge, add a field here; do not
 * add a key space.
 *
 * - `google_oauth`: refresh-rotated OAuth grant. Connected iff an active
 *   credential carries one of `anyOfScopes` — Google's consent screen lets the
 *   user uncheck individual scopes, so row presence alone proves nothing.
 * - `github_app`: App installation (ADR-0052). App *permissions* never land in
 *   the credential's `scopes`, so connectedness is an active row with an
 *   `installation_id`; legacy classic-OAuth rows read as not-connected.
 * - `bearer`: one long-lived bearer token (Notion/Vercel OAuth, Railway pasted
 *   API token). No scopes and no installation to probe — an active row IS the
 *   proof. `connect` says how the token arrives: `token_paste` renders a form,
 *   not a redirect.
 */
export type CredentialSpec =
  | {
      readonly shape: "google_oauth";
      readonly provider: "google";
      /** Consent features the connect route asks for (`?features=`). */
      readonly features: readonly GoogleFeature[];
      /** Connected when an active row holds any one of these. */
      readonly anyOfScopes: readonly GoogleScope[];
    }
  | { readonly shape: "github_app"; readonly provider: "github" }
  | {
      readonly shape: "bearer";
      readonly provider: "notion" | "railway" | "vercel";
      readonly connect: "oauth" | "token_paste";
    };

/** Transport shape of the general read-only passthrough tier (ADR-0074). */
export type PassthroughTransportKind = "rest" | "graphql";

/** `null` is a live provider with no general-invocation tier. */
export type PassthroughSpec = { readonly transport: PassthroughTransportKind } | null;

export interface LiveIntegrationEntry extends EntryBase {
  readonly kind: "provider";
  readonly status: "live";
  readonly brand: string;
  readonly credential: CredentialSpec;
  readonly passthrough: PassthroughSpec;
  /** One line the model reads in the connected summary (ADR-0053). */
  readonly summaryBlurb: string;
  /** Append the connected account identity to the summary line (ADR-0071 F2). */
  readonly identityInSummary?: true;
  /** Host for favicons and evidence grouping, e.g. `github.com`. */
  readonly domain: string;
}

export type IntegrationEntry =
  | InternalIntegrationEntry
  | ChannelIntegrationEntry
  | PlannedIntegrationEntry
  | LiveIntegrationEntry;

// ---------------------------------------------------------------------------
// The record.
// ---------------------------------------------------------------------------

export const INTEGRATIONS = {
  system: { kind: "internal", displayName: "Alfred" },
  // Not loadable: not an OAuth-connectable provider with a passthrough surface,
  // but a projection of N third-party MCP connections behind two fixed actions
  // (ADR-0018). It stays a non-`system` slug so the per-user policy gate and
  // the ADR-0069 high-tier floor still apply to it.
  mcp: { kind: "internal", displayName: "MCP" },
  gmail: {
    kind: "provider",
    status: "live",
    displayName: "Gmail",
    brand: "gmail",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["briefing", "triage", "reply_draft"],
      anyOfScopes: [GMAIL_READONLY_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's email",
    domain: "mail.google.com",
  },
  calendar: {
    kind: "provider",
    status: "live",
    displayName: "Calendar",
    brand: "google_calendar",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["calendar"],
      anyOfScopes: [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's calendar",
    domain: "calendar.google.com",
  },
  drive: {
    kind: "provider",
    status: "live",
    displayName: "Drive",
    brand: "google_drive",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["drive"],
      anyOfScopes: [DRIVE_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's Drive files",
    domain: "drive.google.com",
  },
  docs: {
    kind: "provider",
    status: "live",
    displayName: "Docs",
    brand: "google_docs",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["docs"],
      anyOfScopes: [DOCS_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's Google Docs",
    domain: "docs.google.com",
  },
  sheets: {
    kind: "provider",
    status: "live",
    displayName: "Sheets",
    brand: "google_sheets",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["sheets"],
      anyOfScopes: [SHEETS_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's spreadsheets",
    domain: "sheets.google.com",
  },
  slides: {
    kind: "provider",
    status: "live",
    displayName: "Slides",
    brand: "google_slides",
    credential: {
      shape: "google_oauth",
      provider: "google",
      features: ["slides"],
      anyOfScopes: [SLIDES_SCOPE],
    },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's presentations",
    domain: "slides.google.com",
  },
  slack: { kind: "provider", status: "planned", displayName: "Slack", brand: "slack" },
  linear: { kind: "provider", status: "planned", displayName: "Linear", brand: "linear" },
  github: {
    kind: "provider",
    status: "live",
    displayName: "GitHub",
    brand: "github",
    credential: { shape: "github_app", provider: "github" },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's GitHub issues and pull requests",
    // The connection whose missing identity made the boss ask "which repo?" on
    // a self-referential question: the summary line carries the login.
    identityInSummary: true,
    domain: "github.com",
  },
  notion: {
    kind: "provider",
    status: "live",
    displayName: "Notion",
    brand: "notion",
    credential: { shape: "bearer", provider: "notion", connect: "oauth" },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's Notion pages and databases",
    domain: "notion.so",
  },
  railway: {
    kind: "provider",
    status: "live",
    displayName: "Railway",
    brand: "railway",
    credential: { shape: "bearer", provider: "railway", connect: "token_paste" },
    passthrough: { transport: "graphql" },
    summaryBlurb: "the user's Railway projects, deployments, and logs",
    domain: "railway.com",
  },
  vercel: {
    kind: "provider",
    status: "live",
    displayName: "Vercel",
    brand: "vercel",
    credential: { shape: "bearer", provider: "vercel", connect: "oauth" },
    passthrough: { transport: "rest" },
    summaryBlurb: "the user's Vercel projects and deployments",
    domain: "vercel.com",
  },
  imessage: { kind: "channel", displayName: "iMessage" },
} as const satisfies Record<IntegrationSlug, IntegrationEntry>;

export type IntegrationEntryOf<S extends IntegrationSlug> = (typeof INTEGRATIONS)[S];

/** Typed index into the record: `integrationEntry("github").credential.shape` is `"github_app"`. */
export function integrationEntry<S extends IntegrationSlug>(slug: S): IntegrationEntryOf<S> {
  return INTEGRATIONS[slug];
}

// ---------------------------------------------------------------------------
// Derived unions. Every subset is a mapped conditional over the record, never
// a hand-listed tuple, so it cannot drift from the entries.
// ---------------------------------------------------------------------------

/** The slugs whose entry extends `P`. */
export type SlugsWhere<P> = {
  [K in IntegrationSlug]: IntegrationEntryOf<K> extends P ? K : never;
}[IntegrationSlug];

export type InternalIntegrationSlug = SlugsWhere<{ kind: "internal" }>;
export type ChannelIntegrationSlug = SlugsWhere<{ kind: "channel" }>;
export type LiveProviderSlug = SlugsWhere<{ kind: "provider"; status: "live" }>;
export type PlannedSlug = SlugsWhere<{ kind: "provider"; status: "planned" }>;
/** The slugs that have an integration page. */
export type CatalogSlug = SlugsWhere<{ kind: "provider" }>;
/**
 * Every slug the tool surface can load: a provider or a channel. `system` and
 * `mcp` are excluded — they are Alfred's own machinery, not a connection.
 */
export type LoadableIntegrationSlug = Exclude<IntegrationSlug, InternalIntegrationSlug>;

export type GoogleSlug = SlugsWhere<{ credential: { shape: "google_oauth" } }>;
export type GithubAppSlug = SlugsWhere<{ credential: { shape: "github_app" } }>;
/** The slugs whose access is one long-lived bearer token — the shared bearer persistence layer's domain. */
export type BearerSlug = SlugsWhere<{ credential: { shape: "bearer" } }>;

/** Every `credential.provider` literal in the record: the persisted vocabulary of `integration_credentials.provider`. */
export type CredentialProvider = IntegrationEntryOf<LiveProviderSlug>["credential"]["provider"];

export type SupportedPassthroughSlug = SlugsWhere<{
  passthrough: { transport: PassthroughTransportKind };
}>;
export type SupportedRestSlug = SlugsWhere<{ passthrough: { transport: "rest" } }>;
export type SupportedGraphqlSlug = SlugsWhere<{ passthrough: { transport: "graphql" } }>;

/** Every `brand` literal a provider entry owns; the web keys its icon table on this. */
export type IntegrationBrandKey = IntegrationEntryOf<CatalogSlug>["brand"];

// ---------------------------------------------------------------------------
// Runtime lists. Each is `filter` over the tuple with a predicate that reads the
// record, then an `enumGuard`, so the list and its union always agree.
// ---------------------------------------------------------------------------

export const LOADABLE_INTEGRATION_SLUGS: readonly LoadableIntegrationSlug[] =
  INTEGRATION_SLUGS.filter(
    (slug): slug is LoadableIntegrationSlug => INTEGRATIONS[slug].kind !== "internal",
  );
export const isLoadableIntegrationSlug = enumGuard(LOADABLE_INTEGRATION_SLUGS);

export const CATALOG_SLUGS: readonly CatalogSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is CatalogSlug => INTEGRATIONS[slug].kind === "provider",
);
export const isCatalogSlug = enumGuard(CATALOG_SLUGS);

export const LIVE_PROVIDER_SLUGS: readonly LiveProviderSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is LiveProviderSlug => {
    const entry = INTEGRATIONS[slug];
    return entry.kind === "provider" && entry.status === "live";
  },
);
export const isLiveProviderSlug = enumGuard(LIVE_PROVIDER_SLUGS);

export const PLANNED_SLUGS: readonly PlannedSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is PlannedSlug => {
    const entry = INTEGRATIONS[slug];
    return entry.kind === "provider" && entry.status === "planned";
  },
);
export const isPlannedSlug = enumGuard(PLANNED_SLUGS);

export const BEARER_PROVIDER_SLUGS: readonly BearerSlug[] = LIVE_PROVIDER_SLUGS.filter(
  (slug): slug is BearerSlug => INTEGRATIONS[slug].credential.shape === "bearer",
);
export const isBearerProvider = enumGuard(BEARER_PROVIDER_SLUGS);

/** The distinct providers, in first-appearance slug order (`google` once for six slugs). */
export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  ...new Set(LIVE_PROVIDER_SLUGS.map((slug) => INTEGRATIONS[slug].credential.provider)),
];
export const isCredentialProvider = enumGuard(CREDENTIAL_PROVIDERS);

export const SUPPORTED_PASSTHROUGH_SLUGS: readonly SupportedPassthroughSlug[] =
  LIVE_PROVIDER_SLUGS.filter(
    (slug): slug is SupportedPassthroughSlug => INTEGRATIONS[slug].passthrough !== null,
  );
export const isSupportedPassthroughSlug = enumGuard(SUPPORTED_PASSTHROUGH_SLUGS);

export const SUPPORTED_REST_PASSTHROUGH_SLUGS: readonly SupportedRestSlug[] =
  SUPPORTED_PASSTHROUGH_SLUGS.filter(
    (slug): slug is SupportedRestSlug => INTEGRATIONS[slug].passthrough.transport === "rest",
  );

// ---------------------------------------------------------------------------
// Live provider views.
// ---------------------------------------------------------------------------

/** A live entry with its slug attached, discriminated by slug. */
export type LiveProviderEntry = {
  [K in LiveProviderSlug]: { readonly slug: K } & IntegrationEntryOf<K>;
}[LiveProviderSlug];

const LIVE_PROVIDERS: readonly LiveProviderEntry[] = LIVE_PROVIDER_SLUGS.map(
  // SAFETY: `slug` is drawn from LIVE_PROVIDER_SLUGS and the entry is
  // `INTEGRATIONS[slug]`, so each element is exactly the `{ slug: K } & entry`
  // member for its own K. `map` instantiates the callback with the wide union
  // and cannot express that per-element pairing.
  (slug) => ({ slug, ...INTEGRATIONS[slug] }) as LiveProviderEntry,
);

/** The live providers in registry order — the one loop the assistant and the web iterate. */
export function liveProviders(): readonly LiveProviderEntry[] {
  return LIVE_PROVIDERS;
}

// ---------------------------------------------------------------------------
// Projections. Built from the record in slug order; `Object.fromEntries` erases
// the key set, so each carries one cast that the value-equality tests pin.
// ---------------------------------------------------------------------------

function projectSlugs<K extends string, T>(
  slugs: readonly K[],
  project: (slug: K) => T,
): Readonly<Record<K, T>> {
  // SAFETY: the result has exactly the keys in `slugs`; Object.fromEntries'
  // string index erases that and this cast restores it. The signature cannot
  // prove `slugs` holds every member of K — each caller passes the derived list
  // its K is defined from, and `test/integrations.test.ts` pins every key set.
  return Object.fromEntries(slugs.map((slug) => [slug, project(slug)])) as Record<K, T>;
}

/**
 * The display name of every integration, for prose a user or the model reads
 * (a failure message, a connect nudge). Index it with a typed slug, or call
 * `integrationDisplayName(value)` from `./tools` for an unchecked string.
 */
export const INTEGRATION_DISPLAY_NAMES: Readonly<Record<IntegrationSlug, string>> = projectSlugs(
  INTEGRATION_SLUGS,
  (slug) => INTEGRATIONS[slug].displayName,
);

/**
 * Transitional vocabulary for the two coverage projections below, kept until
 * their consumers read `INTEGRATIONS[slug]` directly (registry plan, PR 4).
 * `deferred` is a `planned` provider; `not_applicable` is a channel.
 */
export type CredentialShape = CredentialSpec["shape"] | "deferred" | "not_applicable";

export const CREDENTIAL_SHAPE: Readonly<Record<LoadableIntegrationSlug, CredentialShape>> =
  projectSlugs(LOADABLE_INTEGRATION_SLUGS, (slug) => {
    const entry = INTEGRATIONS[slug];
    if (entry.kind === "channel") return "not_applicable";
    return entry.status === "planned" ? "deferred" : entry.credential.shape;
  });

export type CoverageDecision = "supported" | "deferred" | "not_applicable";

export const GENERAL_INVOCATION_COVERAGE: Readonly<
  Record<LoadableIntegrationSlug, CoverageDecision>
> = projectSlugs(LOADABLE_INTEGRATION_SLUGS, (slug) => {
  const entry = INTEGRATIONS[slug];
  if (entry.kind === "channel") return "not_applicable";
  if (entry.status === "planned") return "deferred";
  return entry.passthrough === null ? "not_applicable" : "supported";
});

export const PASSTHROUGH_TRANSPORT: Readonly<
  Record<SupportedPassthroughSlug, PassthroughTransportKind>
> = projectSlugs(SUPPORTED_PASSTHROUGH_SLUGS, (slug) => INTEGRATIONS[slug].passthrough.transport);
