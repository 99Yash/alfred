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
 * This module imports only `./types`, `../google-scopes`, and `../guards`.
 * `../tools` reads the record for tool names, so the record cannot read
 * `../tools`.
 */

import { enumGuard } from "../guards";
import type { IntegrationEntry } from "./types";
import { GOOGLE_SCOPE } from "../google-scopes";

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
      "create_artifact",
      "append_artifact_page",
      "append_artifact_section",
      "update_artifact",
    ],
  },
  // Not loadable: not an OAuth-connectable provider with a passthrough surface,
  // but a projection of N third-party MCP connections behind two fixed actions
  // (ADR-0018): `mcp.call` routes a remote tools/call through dispatch and
  // `mcp.list_tools` is a bounded local read of the persisted catalog. The
  // remote tool name and connection ride in the args, never in the tool name.
  // It stays a non-`system` slug so the per-user policy gate and the ADR-0069
  // high-tier floor still apply to it.
  mcp: { kind: "internal", displayName: "MCP", actions: ["call", "list_tools"] },
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
  railway: {
    kind: "provider",
    status: "live",
    displayName: "Railway",
    brand: "railway",
    credential: { shape: "bearer", connect: "token_paste" },
    passthrough: { transport: "graphql" },
    actions: [
      "list_projects",
      "list_deployments",
      "recent_deployments",
      "get_logs",
      "redeploy",
      "graphql",
    ],
    summaryBlurb: "the user's Railway projects, deployments, and logs",
    domain: "railway.com",
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
