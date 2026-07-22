import {
  humanizeSlug,
  isLoadableIntegrationSlug,
  isPassthroughPreferenceOn,
  isSupportedPassthroughSlug,
  PASSTHROUGH_PREFERENCE_KEYS,
  toStringArray,
  type LoadableIntegrationSlug,
  type SupportedIntegrationSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, userPreferences } from "@alfred/db/schemas";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  GMAIL_READONLY_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
} from "@alfred/integrations/google";
import { and, eq, inArray } from "drizzle-orm";
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
  /**
   * Per-integration general-passthrough (ADR-0074) enablement. **Default OFF**:
   * an absent preference row means the tier is disabled, so every supported slug
   * is present here with an explicit boolean (the read resolves the unset case to
   * `false`). {@link evaluateToolAvailability} keys the `feature_disabled` code on
   * this, and the dispatch recheck reads the same map so a kill-switch flip can't
   * be bypassed by a stale active surface.
   */
  passthroughEnabled: ReadonlyMap<SupportedIntegrationSlug, boolean>;
}

/** One credential read projected into exact per-integration capability health. */
export async function readIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const passthroughKeys = Object.values(PASSTHROUGH_PREFERENCE_KEYS);
  const [rows, prefRows] = await Promise.all([
    db()
      .select({
        provider: integrationCredentials.provider,
        status: integrationCredentials.status,
        scopes: integrationCredentials.scopes,
        accountLabel: integrationCredentials.accountLabel,
      })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.userId, userId)),
    db()
      .select({ key: userPreferences.key, value: userPreferences.value })
      .from(userPreferences)
      .where(
        and(eq(userPreferences.userId, userId), inArray(userPreferences.key, passthroughKeys)),
      ),
  ]);

  const prefByKey = new Map(prefRows.map((row) => [row.key, row.value]));
  const passthroughEnabled = new Map<SupportedIntegrationSlug, boolean>();
  for (const [slug, key] of Object.entries(PASSTHROUGH_PREFERENCE_KEYS) as [
    SupportedIntegrationSlug,
    string,
  ][]) {
    passthroughEnabled.set(slug, isPassthroughPreferenceOn(prefByKey.get(key)));
  }

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
  return { integrations: availability, providers: byProvider, passthroughEnabled };
}

/** Why an exact tool cannot run in a given run context. */
export type ToolUnavailabilityCode =
  | "not_allowed"
  | "wrong_caller"
  | "requires_thread"
  | "not_connected"
  | "needs_reauth"
  | "missing_scope"
  // The general read-only passthrough tier (ADR-0074) is default-OFF per
  // integration; a supported passthrough tool whose per-user preference is unset
  // or disabled is `feature_disabled`. Unlike the other codes (which the model
  // sees so it can react), a `feature_disabled` rejection is invisible plumbing —
  // the model must not narrate a capability the user turned off. The gate/dispatch
  // wiring that emits it lands with the first passthrough tool.
  | "feature_disabled";

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
  // ADR-0074: a general read-only passthrough tool is default-OFF per integration
  // and killable without a deploy. Gate it on the per-user preference BEFORE the
  // credential/health block so a user who turned the tier off gets that reason —
  // not an unrelated "not connected". A slug that lost `supported` status (or was
  // never one) is treated as off. When on, the tool still flows through the
  // health check below, so a disabled/disconnected integration is reported honestly.
  if (tool.availability?.passthrough) {
    const enabled =
      isSupportedPassthroughSlug(tool.integration) &&
      snapshot.passthroughEnabled.get(tool.integration) === true;
    if (!enabled) {
      return {
        available: false,
        code: "feature_disabled",
        reason: `${name} raw API access is turned off. Enable it under Settings → Features to use this tool.`,
      };
    }
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

  // Loadable (OAuth-connected) integrations gate on their connection health.
  // `system` and `mcp` are not in this snapshot: `mcp` connection health lives
  // on `mcp_connections` and is resolved by the broker/connection manager, so
  // an `mcp.*` tool is not blocked here.
  if (isLoadableIntegrationSlug(tool.integration)) {
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

/**
 * Evaluate every candidate tool once and keep the whole {@link
 * ToolAvailabilityResult} — availability *and*, when unavailable, the reason.
 * Tool discovery (#413) consumes this as its single availability source: whether
 * a tool can run and why-not read from the same result object, so a surfaced
 * tool can never contradict its own reason and no tool is evaluated twice.
 */
export function evaluateToolCatalog(
  snapshot: IntegrationAvailabilitySnapshot,
  tools: readonly RegisteredTool[],
  allowedIntegrations: readonly string[],
  context: ToolAvailabilityContext,
): Map<RegisteredTool["name"], ToolAvailabilityResult> {
  const allowed = new Set(allowedIntegrations);
  const out = new Map<RegisteredTool["name"], ToolAvailabilityResult>();
  for (const tool of tools) {
    out.set(tool.name, evaluateToolAvailability(snapshot, tool, allowed, context));
  }
  return out;
}
