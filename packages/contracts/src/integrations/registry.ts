/**
 * The integration registry (ADR-0093). Its keys are the slug space: spell a slug
 * here and nowhere else. Other slug tables derive from it (`./projections`, `./slugs`).
 * Do not import `../tools` here: `../tools` reads this record.
 */

import { enumGuard } from "../guards";
import { GOOGLE_SCOPE, type GoogleFeature, type GoogleScope } from "../google-scopes";
import { typedKeys } from "../records";

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
export interface ChannelIntegrationEntry extends SourceEntryBase {
  readonly kind: "channel";
}

/**
 * How a source reaches the activity record (ADR-0118 decision 3).
 * - `ingest`: events arrive by push or by poll, and Alfred stores them.
 * - `live`: a Context Search source reads the provider at query time.
 * - `tools_only`: the tools work in chat. The record has no events from this source.
 */
export type SourceRoute = "ingest" | "live" | "tools_only";

/** `tools_only` stands alone. A source can ingest and read live (Calendar: past and future events). */
export type SourceRoutes =
  | readonly ["ingest"]
  | readonly ["live"]
  | readonly ["ingest", "live"]
  | readonly ["tools_only"];

/** True when `routes` holds `route`. */
export function hasSourceRoute(routes: SourceRoutes, route: SourceRoute): boolean {
  return routes.some((held) => held === route);
}

/** An entry for a source of events. Internal entries are not sources, so they have no routes. */
interface SourceEntryBase extends EntryBase {
  /** Set to what is built today, not to the plan. */
  readonly sourceRoutes: SourceRoutes;
}

/** A provider that has a page and a brand but no wired credential store yet. */
export interface PlannedIntegrationEntry extends SourceEntryBase {
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
 * - `bearer`: an active row is the proof.
 */
export type CredentialSpec =
  | {
      readonly shape: "google_oauth";
      /** Sent as `?features=` on connect. */
      readonly features: readonly GoogleFeature[];
      /** The connected proof, and the scopes a read of this integration needs. */
      readonly anyOfScopes: readonly GoogleScope[];
      /** Named grants other than a read. `{}` when a read grant covers every call. */
      readonly grants: Readonly<Record<string, readonly GoogleScope[]>>;
    }
  | { readonly shape: "github_app" }
  | { readonly shape: "bearer"; readonly connect: "oauth" };

/** ADR-0074 read-only passthrough. */
export type PassthroughTransportKind = "rest" | "graphql";

/** `null`: no passthrough tier. */
export type PassthroughSpec = { readonly transport: PassthroughTransportKind } | null;

export interface LiveIntegrationEntry extends SourceEntryBase {
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
      "list_todos",
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
    sourceRoutes: ["ingest"],
    credential: {
      shape: "google_oauth",
      features: ["briefing", "triage", "reply_draft"],
      anyOfScopes: [GOOGLE_SCOPE.gmail.readonly, GOOGLE_SCOPE.gmail.modify],
      grants: { modify: [GOOGLE_SCOPE.gmail.modify], send: [GOOGLE_SCOPE.gmail.send] },
    },
    passthrough: { transport: "rest" },
    actions: [
      "search",
      "read_message",
      "get_thread",
      "modify_thread",
      "modify_message",
      "create_draft",
      "send_draft",
      "request",
    ],
    summaryBlurb: "the user's email",
    domain: "mail.google.com",
  },
  calendar: {
    kind: "provider",
    status: "live",
    displayName: "Calendar",
    brand: "google_calendar",
    // No ingest and no Context Search source yet. ADR-0118 plans ingest (past) and live (future).
    sourceRoutes: ["tools_only"],
    credential: {
      shape: "google_oauth",
      features: ["calendar"],
      anyOfScopes: [GOOGLE_SCOPE.calendar.readonly, GOOGLE_SCOPE.calendar.events],
      grants: { write: [GOOGLE_SCOPE.calendar.events] },
    },
    passthrough: { transport: "rest" },
    actions: [
      "list_events",
      "create_event",
      "update_event",
      "delete_event",
      "respond_to_event",
      "request",
    ],
    summaryBlurb: "the user's calendar",
    domain: "calendar.google.com",
  },
  drive: {
    kind: "provider",
    status: "live",
    displayName: "Drive",
    brand: "google_drive",
    // The Drive Context Search source reads files at query time (ADR-0104).
    sourceRoutes: ["live"],
    credential: {
      shape: "google_oauth",
      features: ["drive"],
      anyOfScopes: [GOOGLE_SCOPE.drive.full],
      grants: {},
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
    sourceRoutes: ["tools_only"],
    credential: {
      shape: "google_oauth",
      features: ["docs"],
      anyOfScopes: [GOOGLE_SCOPE.docs.full],
      grants: {},
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
    sourceRoutes: ["tools_only"],
    credential: {
      shape: "google_oauth",
      features: ["sheets"],
      anyOfScopes: [GOOGLE_SCOPE.sheets.full],
      grants: {},
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
    sourceRoutes: ["tools_only"],
    credential: {
      shape: "google_oauth",
      features: ["slides"],
      anyOfScopes: [GOOGLE_SCOPE.slides.full],
      grants: {},
    },
    passthrough: { transport: "rest" },
    actions: ["create_presentation", "get_presentation", "batch_update", "add_slide", "request"],
    summaryBlurb: "the user's presentations",
    domain: "slides.google.com",
  },
  contacts: {
    kind: "provider",
    status: "live",
    displayName: "Contacts",
    brand: "google_contacts",
    sourceRoutes: ["tools_only"],
    credential: {
      shape: "google_oauth",
      features: ["contacts"],
      anyOfScopes: [GOOGLE_SCOPE.contacts.readonly, GOOGLE_SCOPE.contacts.other],
      grants: {},
    },
    passthrough: null,
    actions: ["search", "list", "get"],
    summaryBlurb: "the user's saved contacts and the people they email",
    domain: "contacts.google.com",
  },
  slack: {
    kind: "provider",
    status: "planned",
    displayName: "Slack",
    brand: "slack",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  linear: {
    kind: "provider",
    status: "planned",
    displayName: "Linear",
    brand: "linear",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  github: {
    kind: "provider",
    status: "live",
    displayName: "GitHub",
    brand: "github",
    sourceRoutes: ["ingest"],
    credential: { shape: "github_app" },
    passthrough: { transport: "rest" },
    actions: [
      "search",
      "get_pull_request",
      "get_pull_requests",
      "get_issue",
      "get_issues",
      "request",
    ],
    summaryBlurb: "the user's GitHub issues and pull requests",
    // Without the login, the boss asked "which repo?" about the user's own work.
    identityInSummary: true,
    domain: "github.com",
  },
  vercel: {
    kind: "provider",
    status: "live",
    displayName: "Vercel",
    brand: "vercel",
    // Deployments arrive as a GitHub `repository_dispatch` push (#1167) and a pull (#1193).
    sourceRoutes: ["ingest"],
    credential: { shape: "bearer", connect: "oauth" },
    passthrough: { transport: "rest" },
    actions: ["list_projects", "list_deployments", "redeploy", "request"],
    summaryBlurb: "the user's Vercel projects and deployments",
    domain: "vercel.com",
  },
  // Sentry, Notion, Railway, Polylane and ClickUp (and Linear) are `planned` here but connect through MCP.
  // The entries exist for the slug and the brand art the MCP catalog uses (ADR-0093).
  sentry: {
    kind: "provider",
    status: "planned",
    displayName: "Sentry",
    brand: "sentry",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  notion: {
    kind: "provider",
    status: "planned",
    displayName: "Notion",
    brand: "notion",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  railway: {
    kind: "provider",
    status: "planned",
    displayName: "Railway",
    brand: "railway",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  polylane: {
    kind: "provider",
    status: "planned",
    displayName: "Polylane",
    brand: "polylane",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  clickup: {
    kind: "provider",
    status: "planned",
    displayName: "ClickUp",
    brand: "clickup",
    sourceRoutes: ["tools_only"],
    actions: [],
  },
  imessage: { kind: "channel", displayName: "iMessage", sourceRoutes: ["tools_only"], actions: [] },
} as const satisfies Record<string, IntegrationEntry>;

export type IntegrationSlug = keyof typeof INTEGRATIONS;

/** In record order. */
export const INTEGRATION_SLUGS: readonly IntegrationSlug[] = typedKeys(INTEGRATIONS);

export const isIntegrationSlug = enumGuard(INTEGRATION_SLUGS);

export type IntegrationEntryOf<S extends IntegrationSlug> = (typeof INTEGRATIONS)[S];

/** Keeps the per-slug literal type: `integrationEntry("github").credential.shape` is `"github_app"`. */
export function integrationEntry<S extends IntegrationSlug>(slug: S): IntegrationEntryOf<S> {
  return INTEGRATIONS[slug];
}
