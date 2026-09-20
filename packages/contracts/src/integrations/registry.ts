/**
 * The integration registry (ADR-0093): one record per integration. The record's
 * keys ARE the slug space. `IntegrationSlug` is `keyof` the record and
 * `INTEGRATION_SLUGS` is its key list, so a slug is spelled once, here, and
 * nowhere else. Every per-integration fact (name, kind, status, brand,
 * credential, passthrough, tool actions, summary line, domain) is a field on
 * the entry; every other slug-keyed table in the repo is a projection of this
 * record (`./projections`) or an exhaustive sibling keyed by a union derived
 * from it (`./slugs`).
 *
 * This module imports only `../google-scopes` and `../guards`.
 * `../tools` reads the record for tool names, so the record cannot read
 * `../tools`.
 *
 * Terminology: see `docs/reference/glossary.md`.
 *
 * The entry shapes live here rather than a `types.ts`: the registry stores the
 * `IntegrationEntry` contract (`INTEGRATIONS` is `Record<IntegrationSlug,
 * IntegrationEntry>`), so the shape and its one registered user co-change. The
 * derived unions are in `./slugs`; the transitional tables are in
 * `./projections`; the executable connectedness rule is in `./connected`.
 */

import { enumGuard } from "../guards";
import { GOOGLE_SCOPE, type GoogleFeature, type GoogleScope } from "../google-scopes";

/*
 * The entry shapes are the registry's source of truth, deliberately hand-written
 * rather than derived: `INTEGRATIONS` below is a compile-time declaration, not a
 * table or wire schema, and each `kind` arm's field set IS the contract — a
 * planned provider has no `credential`, a non-provider has no `status` field.
 */

interface EntryBase {
  /** Display name for prose a user or the model reads. */
  readonly displayName: string;
  /**
   * The tool actions this integration registers. `${slug}.${action}` is the
   * tool name. A planned provider registers none; its type says so.
   */
  readonly actions: readonly string[];
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
  readonly actions: readonly [];
}

/**
 * How a live provider's credential is stored and how "connected" is proved.
 *
 * The credential *provider* (the value in `integration_credentials.provider`
 * and the route family `/api/integrations/<provider>/...`) is not a field. It
 * is `"google"` for a `google_oauth` credential and the slug for every other
 * shape, so the record cannot pair one slug with another slug's route family.
 * Read it with `credentialProviderOf(slug)` from `./slugs`. If a provider ever
 * differs from its slug, add a field then; do not add a key space.
 *
 * - `google_oauth`: refresh-rotated OAuth grant. Connected iff an active
 *   credential carries one of `anyOfScopes`: Google's consent screen lets the
 *   user uncheck individual scopes, so row presence alone proves nothing. The
 *   web's older probe was an AND of ORs; every provider has one requirement,
 *   so the flat OR here is the same predicate.
 * - `github_app`: App installation (ADR-0052). App *permissions* never land in
 *   the credential's `scopes`, so connectedness is an active row with an
 *   `installation_id`; legacy classic-OAuth rows read as not-connected.
 * - `bearer`: one long-lived bearer token (Notion/Vercel OAuth, Sentry pasted
 *   API token). No scopes and no installation to probe: an active row IS the
 *   proof. `connect` says how the token arrives; `token_paste` renders a form,
 *   not a redirect.
 */
export type CredentialSpec =
  | {
      readonly shape: "google_oauth";
      /** Consent features the connect route asks for (`?features=`). */
      readonly features: readonly GoogleFeature[];
      /** Connected when an active row holds any one of these. */
      readonly anyOfScopes: readonly GoogleScope[];
    }
  | { readonly shape: "github_app" }
  | { readonly shape: "bearer"; readonly connect: "oauth" | "token_paste" };

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

export const INTEGRATIONS = {
  system: {
    kind: "internal",
    displayName: "Alfred",
    actions: [
      "search_tools",
      "load_tool",
      "current_time",
      "author_workflow",
      "recover_workflow",
      "activate_workflow",
      "spawn_sub_agent",
      "await_sub_agent",
      "read_user_context",
      "read_chat_history",
      "read_scratch",
      "write_scratch",
      "promote",
      "remember",
      "list_instructions",
      "forget_instruction",
      "edit_instruction",
      "resolve_todo",
      "suggest_todo",
      "web_search",
      "fetch_url",
      "corpus_search",
      "search_context",
      "create_artifact",
      "append_artifact_page",
      "append_artifact_section",
      "update_artifact",
      "ask_user",
    ],
  },
  // Not loadable: not an OAuth-connectable provider with a passthrough surface,
  // but a projection of N third-party MCP connections behind fixed actions
  // (ADR-0018): `mcp.call` routes a remote tools/call through dispatch;
  // `mcp.list_tools` and `mcp.inspect_tool` read the persisted catalog. The
  // remote tool name and connection ride in the args, never in the tool name.
  // It stays a non-`system` slug so the per-user policy gate and the ADR-0069
  // high-tier floor still apply to it.
  mcp: { kind: "internal", displayName: "MCP", actions: ["call", "list_tools", "inspect_tool"] },
  gmail: {
    kind: "provider",
    status: "live",
    displayName: "Gmail",
    brand: "gmail",
    credential: {
      shape: "google_oauth",
      features: ["briefing", "triage", "reply_draft"],
      anyOfScopes: [GOOGLE_SCOPE.gmail.readonly],
    },
    passthrough: { transport: "rest" },
    actions: ["search", "read_message", "send_draft", "request"],
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
      features: ["calendar"],
      anyOfScopes: [GOOGLE_SCOPE.calendar.readonly, GOOGLE_SCOPE.calendar.events],
    },
    passthrough: { transport: "rest" },
    actions: ["list_events", "create_event", "request"],
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
      features: ["drive"],
      anyOfScopes: [GOOGLE_SCOPE.drive.full],
    },
    passthrough: { transport: "rest" },
    actions: ["search_files", "get_file", "export_file", "download_file", "request"],
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
      features: ["docs"],
      anyOfScopes: [GOOGLE_SCOPE.docs.full],
    },
    passthrough: { transport: "rest" },
    actions: ["get_document", "request"],
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
      features: ["sheets"],
      anyOfScopes: [GOOGLE_SCOPE.sheets.full],
    },
    passthrough: { transport: "rest" },
    actions: [
      "create_spreadsheet",
      "get_values",
      "update_values",
      "append_values",
      "batch_update",
      "add_sheet",
      "request",
    ],
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
      features: ["slides"],
      anyOfScopes: [GOOGLE_SCOPE.slides.full],
    },
    passthrough: { transport: "rest" },
    actions: ["create_presentation", "get_presentation", "batch_update", "add_slide", "request"],
    summaryBlurb: "the user's presentations",
    domain: "slides.google.com",
  },
  slack: { kind: "provider", status: "planned", displayName: "Slack", brand: "slack", actions: [] },
  linear: {
    kind: "provider",
    status: "planned",
    displayName: "Linear",
    brand: "linear",
    actions: [],
  },
  github: {
    kind: "provider",
    status: "live",
    displayName: "GitHub",
    brand: "github",
    credential: { shape: "github_app" },
    passthrough: { transport: "rest" },
    actions: ["search", "get_pull_request", "get_pull_requests", "get_issue", "request"],
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
    credential: { shape: "bearer", connect: "oauth" },
    passthrough: { transport: "rest" },
    actions: ["search", "get_page", "create_page", "append_blocks", "request"],
    summaryBlurb: "the user's Notion pages and databases",
    domain: "notion.so",
  },
  vercel: {
    kind: "provider",
    status: "live",
    displayName: "Vercel",
    brand: "vercel",
    credential: { shape: "bearer", connect: "oauth" },
    passthrough: { transport: "rest" },
    actions: ["list_projects", "list_deployments", "redeploy", "request"],
    summaryBlurb: "the user's Vercel projects and deployments",
    domain: "vercel.com",
  },
  sentry: {
    kind: "provider",
    status: "live",
    displayName: "Sentry",
    brand: "sentry",
    credential: { shape: "bearer", connect: "token_paste" },
    passthrough: { transport: "rest" },
    actions: ["request"],
    summaryBlurb: "the user's Sentry issues and error events",
    domain: "sentry.io",
  },
  // `planned` as a PRODUCT integration: Alfred has no Polylane REST credential
  // and registers no `polylane.*` tool. The entry exists so the slug resolves
  // and carries brand artwork, which is what the built-in MCP catalog borrows
  // (ADR-0093). Linear is the same shape. The connection itself is real and
  // lives on the MCP surface, not here.
  polylane: {
    kind: "provider",
    status: "planned",
    displayName: "Polylane",
    brand: "polylane",
    actions: [],
  },
  imessage: { kind: "channel", displayName: "iMessage", actions: [] },
} as const satisfies Record<string, IntegrationEntry>;

/** The id space: the record's keys. Nothing else identifies an integration. */
export type IntegrationSlug = keyof typeof INTEGRATIONS;

/**
 * The slugs in record order. `Object.keys` keeps insertion order for string
 * keys, so this order is the order the record is written in.
 */
export const INTEGRATION_SLUGS: readonly IntegrationSlug[] =
  // SAFETY: `Object.keys` types its result as `string[]`; the keys of a
  // non-indexed literal are exactly `keyof typeof INTEGRATIONS`.
  Object.keys(INTEGRATIONS) as IntegrationSlug[];

export const isIntegrationSlug = enumGuard(INTEGRATION_SLUGS);

export type IntegrationEntryOf<S extends IntegrationSlug> = (typeof INTEGRATIONS)[S];

/** Typed index into the record: `integrationEntry("github").credential.shape` is `"github_app"`. */
export function integrationEntry<S extends IntegrationSlug>(slug: S): IntegrationEntryOf<S> {
  return INTEGRATIONS[slug];
}
