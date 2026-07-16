import { humanizeSlug, toStringArray, type LoadableIntegrationSlug } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  GMAIL_READONLY_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
} from "@alfred/integrations/google";
import { eq } from "drizzle-orm";
import type { RegisteredTool } from "../tools/registry";

interface IntegrationAccessSpec {
  slug: LoadableIntegrationSlug;
  provider: string;
  anyOfScopes: readonly string[];
}

const ACCESS_SPECS: readonly IntegrationAccessSpec[] = [
  { slug: "gmail", provider: "google", anyOfScopes: [GMAIL_READONLY_SCOPE] },
  {
    slug: "calendar",
    provider: "google",
    anyOfScopes: [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE],
  },
  { slug: "drive", provider: "google", anyOfScopes: [DRIVE_SCOPE] },
  { slug: "docs", provider: "google", anyOfScopes: [DOCS_SCOPE] },
  { slug: "sheets", provider: "google", anyOfScopes: [SHEETS_SCOPE] },
  { slug: "slides", provider: "google", anyOfScopes: [SLIDES_SCOPE] },
  { slug: "github", provider: "github", anyOfScopes: [] },
  { slug: "notion", provider: "notion", anyOfScopes: [] },
  { slug: "railway", provider: "railway", anyOfScopes: [] },
  { slug: "vercel", provider: "vercel", anyOfScopes: [] },
];

interface ProviderRow {
  status: string;
  scopes: Set<string>;
  accountLabel: string | null;
}

export interface IntegrationAvailability {
  health: "active" | "needs_reauth" | null;
  accountLabel: string | null;
}

export interface ToolAvailabilityContext {
  caller: "boss" | "sub_agent";
  hasThread: boolean;
}

export interface IntegrationAvailabilitySnapshot {
  integrations: ReadonlyMap<LoadableIntegrationSlug, IntegrationAvailability>;
  providers: ReadonlyMap<string, readonly ProviderRow[]>;
}

/** One credential read projected into exact per-integration capability health. */
export async function readIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const rows = await db()
    .select({
      provider: integrationCredentials.provider,
      status: integrationCredentials.status,
      scopes: integrationCredentials.scopes,
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.userId, userId));

  const byProvider = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push({
      status: row.status,
      scopes: new Set(toStringArray(row.scopes)),
      accountLabel: row.accountLabel,
    });
    byProvider.set(row.provider, list);
  }

  const availability = new Map<LoadableIntegrationSlug, IntegrationAvailability>();
  for (const spec of ACCESS_SPECS) {
    const providerRows = byProvider.get(spec.provider);
    if (!providerRows || providerRows.length === 0) {
      availability.set(spec.slug, { health: null, accountLabel: null });
      continue;
    }
    const active = providerRows.find(
      (row) =>
        row.status === "active" &&
        (spec.anyOfScopes.length === 0 || spec.anyOfScopes.some((scope) => row.scopes.has(scope))),
    );
    availability.set(spec.slug, {
      health: active ? "active" : "needs_reauth",
      accountLabel: active?.accountLabel?.trim() || null,
    });
  }
  return { integrations: availability, providers: byProvider };
}

/** Why an exact tool cannot run in a given run context. */
export type ToolUnavailabilityCode =
  | "not_allowed"
  | "wrong_caller"
  | "requires_thread"
  | "not_connected"
  | "needs_reauth"
  | "missing_scope";

export type ToolAvailabilityResult =
  | { available: true }
  | { available: false; code: ToolUnavailabilityCode; reason: string };

/**
 * Single source of truth for whether one exact tool can run, and if not, why.
 * Gate order matches the surfaces that consume it: the workflow integration
 * allowlist, then caller/thread context, then credential health. {@link
 * availableToolNames} keeps the `available === true` names; tool discovery
 * (#413) uses the `reason` to explain a strong-but-unavailable match instead of
 * silently dropping it.
 */
export function evaluateToolAvailability(
  snapshot: IntegrationAvailabilitySnapshot,
  tool: RegisteredTool,
  allowed: ReadonlySet<string>,
  context: ToolAvailabilityContext,
): ToolAvailabilityResult {
  const name = humanizeSlug(tool.integration);

  if (tool.integration !== "system" && allowed.size > 0 && !allowed.has(tool.integration)) {
    return {
      available: false,
      code: "not_allowed",
      reason: "Outside this workflow's integration allowlist.",
    };
  }
  if (tool.availability?.callers && !tool.availability.callers.includes(context.caller)) {
    return {
      available: false,
      code: "wrong_caller",
      reason: `Only the ${tool.availability.callers.join(" / ")} caller may use this tool.`,
    };
  }
  if (tool.availability?.requiresThread && !context.hasThread) {
    return {
      available: false,
      code: "requires_thread",
      reason: "Runs only inside an interactive chat thread.",
    };
  }

  const credential = tool.availability?.credential;
  if (credential) {
    const providerRows = snapshot.providers.get(credential.provider) ?? [];
    if (providerRows.length === 0) {
      return { available: false, code: "not_connected", reason: `${name} is not connected.` };
    }
    const activeRows = providerRows.filter((row) => row.status === "active");
    if (activeRows.length === 0) {
      return { available: false, code: "needs_reauth", reason: `${name} needs to be reconnected.` };
    }
    const scopeMatches =
      credential.anyOfScopes.length === 0 ||
      activeRows.some((row) => credential.anyOfScopes.some((scope) => row.scopes.has(scope)));
    if (!scopeMatches) {
      return {
        available: false,
        code: "missing_scope",
        reason: `${name} is connected but missing a required permission; reconnect to grant it.`,
      };
    }
    return { available: true };
  }

  if (tool.integration !== "system") {
    const health = snapshot.integrations.get(tool.integration)?.health;
    if (health === "needs_reauth") {
      return { available: false, code: "needs_reauth", reason: `${name} needs to be reconnected.` };
    }
    if (health !== "active") {
      return { available: false, code: "not_connected", reason: `${name} is not connected.` };
    }
  }
  return { available: true };
}

export function availableToolNames(
  snapshot: IntegrationAvailabilitySnapshot,
  tools: readonly RegisteredTool[],
  allowedIntegrations: readonly string[],
  context: ToolAvailabilityContext,
): Set<RegisteredTool["name"]> {
  const allowed = new Set(allowedIntegrations);
  const available = new Set<RegisteredTool["name"]>();
  for (const tool of tools) {
    if (evaluateToolAvailability(snapshot, tool, allowed, context).available) {
      available.add(tool.name);
    }
  }
  return available;
}
