/**
 * The integration registry (ADR-0093). Its keys are the slug space: spell a slug
 * here and nowhere else. Other slug tables derive from it (`./projections`, `./slugs`).
 * Do not import `../tools` here: `../tools` reads this record.
 */

import { enumGuard } from "../guards";
import { GOOGLE_SCOPE, type GoogleFeature, type GoogleScope } from "../google-scopes";

// Hand-written on purpose: each `kind` arm's field set is the contract.

interface EntryBase {
  readonly displayName: string;
  /** The tool name is `${slug}.${action}`. */
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
  /** Web asset key for the icon and accent. */
  readonly brand: string;
  readonly actions: readonly [];
}

/**
 * How a live provider stores its credential and proves "connected".
 * The credential provider is derived, not stored: see `credentialProviderOf`.
 * - `google_oauth`: needs one of `anyOfScopes`, because users can uncheck scopes.
 * - `github_app`: needs an `installation_id` (ADR-0052). Old OAuth rows do not count.
 * - `bearer`: an active row is the proof. `token_paste` shows a form, not a redirect.
 */
export type CredentialSpec =
  | {
      readonly shape: "google_oauth";
      /** Sent as `?features=` on connect. */
      readonly features: readonly GoogleFeature[];
      readonly anyOfScopes: readonly GoogleScope[];
    }
  | { readonly shape: "github_app" }
  | { readonly shape: "bearer"; readonly connect: "oauth" | "token_paste" };

/** ADR-0074 read-only passthrough. */
export type PassthroughTransportKind = "rest" | "graphql";

/** `null`: no passthrough tier. */
export type PassthroughSpec = { readonly transport: PassthroughTransportKind } | null;

export interface LiveIntegrationEntry extends EntryBase {
  readonly kind: "provider";
  readonly status: "live";
  readonly brand: string;
  readonly credential: CredentialSpec;
  readonly passthrough: PassthroughSpec;
  /** The model reads this in the connected summary (ADR-0053). */
  readonly summaryBlurb: string;
  /** Add the account identity to the summary line (ADR-0071 F2). */
  readonly identityInSummary?: true;
  /** For favicons and evidence groups. */
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
  // All MCP connections behind fixed actions (ADR-0018). The remote tool goes in
  // the args. Not `system`, so the policy gate and ADR-0069 high-tier floor apply.
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
    // Without the login, the boss asked "which repo?" about the user's own work.
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
  // Railway and Polylane (and Linear) are `planned` here but connect through MCP.
  // The entries exist for the slug and the brand art the MCP catalog uses (ADR-0093).
  railway: {
    kind: "provider",
    status: "planned",
    displayName: "Railway",
    brand: "railway",
    actions: [],
  },
  polylane: {
    kind: "provider",
    status: "planned",
    displayName: "Polylane",
    brand: "polylane",
    actions: [],
  },
  imessage: { kind: "channel", displayName: "iMessage", actions: [] },
} as const satisfies Record<string, IntegrationEntry>;

export type IntegrationSlug = keyof typeof INTEGRATIONS;

/** In record order. */
export const INTEGRATION_SLUGS: readonly IntegrationSlug[] =
  // SAFETY: the keys of a non-indexed literal are exactly `keyof typeof INTEGRATIONS`.
  Object.keys(INTEGRATIONS) as IntegrationSlug[];

export const isIntegrationSlug = enumGuard(INTEGRATION_SLUGS);

export type IntegrationEntryOf<S extends IntegrationSlug> = (typeof INTEGRATIONS)[S];

/** Keeps the per-slug literal type: `integrationEntry("github").credential.shape` is `"github_app"`. */
export function integrationEntry<S extends IntegrationSlug>(slug: S): IntegrationEntryOf<S> {
  return INTEGRATIONS[slug];
}
