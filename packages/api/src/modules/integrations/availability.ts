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

export interface ProviderAvailability {
  credentialId: string;
  accountId: string;
  status: string;
  scopes: Set<string>;
  accountLabel: string | null;
  metadata: Record<string, unknown>;
}

export interface IntegrationAvailability {
  health: "active" | "needs_reauth" | null;
  accountLabel: string | null;
}

export interface ToolAvailabilityContext {
  caller: "boss" | "sub_agent";
  hasThread: boolean;
}

/**
 * Project a dispatch/execute context onto the two facts availability actually
 * gates on. Exists so the surface and the floor cannot disagree about how a
 * caller maps: the mapping used to be a hand-written ternary at each call site,
 * where a divergence would be invisible (the expressions look alike) and would
 * show up as a tool that passes discovery and is refused at dispatch, or the
 * reverse. Sibling of `callerLabel`, which does the same for span labels.
 */
export function toolAvailabilityContext(args: {
  caller: "boss" | { subId: string } | undefined;
  threadId: string | null | undefined;
}): ToolAvailabilityContext {
  return {
    caller: args.caller === undefined || args.caller === "boss" ? "boss" : "sub_agent",
    hasThread: Boolean(args.threadId),
  };
}

export interface IntegrationAvailabilitySnapshot {
  integrations: ReadonlyMap<LoadableIntegrationSlug, IntegrationAvailability>;
  providers: ReadonlyMap<string, readonly ProviderAvailability[]>;
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

/**
 * How long a snapshot is reused. Deliberately short: the whole point of the
 * dispatch floor reading availability LIVE is that a grant revoked or a kill
 * switch flipped since the surface was built must bounce the call, so the window
 * in which a stale snapshot could let one through has to be far smaller than the
 * gap it closes (turn start → dispatch, seconds to minutes). Inside the window
 * the worst case is the pre-floor behavior: the call executes and fails with the
 * provider's own auth error.
 */
const AVAILABILITY_MEMO_TTL_MS = 3_000;

interface AvailabilityMemoEntry {
  readAt: number;
  snapshot: Promise<IntegrationAvailabilitySnapshot>;
}

const availabilityMemo = new Map<string, AvailabilityMemoEntry>();

/**
 * One credential read projected into exact per-integration capability health,
 * memoized per user for {@link AVAILABILITY_MEMO_TTL_MS}.
 *
 * The memo lives HERE, on the read, rather than at each caller: the dispatch
 * floor now resolves availability on every call, so a round of five parallel
 * Gmail calls would otherwise issue ten of these. Callers that used to hand-roll
 * `availability ??= await readIntegrationAvailability(...)` just call it.
 *
 * Caching the promise (not the result) also collapses concurrent callers in the
 * same round onto one query. A rejected read is evicted so the next caller
 * retries instead of inheriting a poisoned entry — same shape as
 * `getResolvedPolicy`, minus its bust protocol: expiry by time means no write
 * site has to know this cache exists, which is the trade for a bounded staleness
 * window rather than an exact one.
 */
export function readIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const now = Date.now();
  const cached = availabilityMemo.get(userId);
  if (cached && now - cached.readAt < AVAILABILITY_MEMO_TTL_MS) return cached.snapshot;

  // Drop everything already expired while we are here — the map is keyed by user
  // and entries are never otherwise removed, so this is what bounds it.
  for (const [key, entry] of availabilityMemo) {
    if (now - entry.readAt >= AVAILABILITY_MEMO_TTL_MS) availabilityMemo.delete(key);
  }

  const pending = loadIntegrationAvailability(userId).catch((err: unknown) => {
    availabilityMemo.delete(userId);
    throw err;
  });
  availabilityMemo.set(userId, { readAt: now, snapshot: pending });
  return pending;
}

/** Bypass the short dispatch memo for approval-time readiness revalidation. */
export async function readFreshIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  availabilityMemo.delete(userId);
  return readIntegrationAvailability(userId);
}

/** Drop every memoized snapshot. Test-only — production entries expire by time. */
export function clearIntegrationAvailabilityMemoForTests(): void {
  availabilityMemo.clear();
}

async function loadIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const passthroughKeys = Object.values(PASSTHROUGH_PREFERENCE_KEYS);
  const [rows, prefRows] = await Promise.all([
    db()
      .select({
        id: integrationCredentials.id,
        provider: integrationCredentials.provider,
        accountId: integrationCredentials.accountId,
        status: integrationCredentials.status,
        scopes: integrationCredentials.scopes,
        accountLabel: integrationCredentials.accountLabel,
        metadata: integrationCredentials.metadata,
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

  const byProvider = new Map<string, ProviderAvailability[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push({
      credentialId: row.id,
      accountId: row.accountId,
      status: row.status,
      scopes: new Set(toStringArray(row.scopes)),
      accountLabel: row.accountLabel,
      metadata: row.metadata,
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
 * Phase 1 of {@link evaluateToolAvailability}: the gates decidable from the
 * registration plus the run context alone. Pure and I/O-free, which is what lets
 * {@link resolveToolAvailability} answer for a `system.*` tool without touching
 * the database.
 */
function evaluateRunContextGates(
  tool: RegisteredTool,
  allowed: ReadonlySet<string>,
  context: ToolAvailabilityContext,
): ToolAvailabilityResult {
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
  return { available: true };
}

/**
 * Whether {@link evaluateSnapshotGates} can reject this tool at all. Exists so
 * {@link resolveToolAvailability} can skip the credential/preference read for the
 * tools it could never answer differently — `system.*` and `mcp.*` carry no
 * credential of their own and are not in the snapshot.
 *
 * This predicate necessarily restates the conditions phase 2 branches on, which
 * means a permission fact with two homes: a `false` here is a PROMISE that phase
 * 2 would have returned `available: true`, and a fourth gate added to phase 2
 * without updating this one would resolve `available` at the floor for a tool
 * discovery still refuses — surface and floor disagreeing, the exact failure the
 * unconditional floor check exists to prevent. So the promise is not held by this
 * comment: `test/tools/availability-snapshot-contract.test.ts` asserts it over the
 * REAL registered catalog against an empty snapshot, which fails on any new gate
 * that can reject a tool this returns `false` for.
 */
export function readsAvailabilitySnapshot(tool: RegisteredTool): boolean {
  return (
    tool.availability?.passthrough === true ||
    tool.availability?.credential !== undefined ||
    isLoadableIntegrationSlug(tool.integration)
  );
}

/**
 * Phase 2 of {@link evaluateToolAvailability}: the gates that need the
 * credential + preference snapshot. Reads nothing from the run context — a tool
 * that clears these is runnable for any caller in any thread.
 */
function evaluateSnapshotGates(
  snapshot: IntegrationAvailabilitySnapshot,
  tool: RegisteredTool,
): ToolAvailabilityResult {
  const name = humanizeSlug(tool.integration);

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

/**
 * Single source of truth for whether one exact tool can run, and if not, why.
 * Gate order is the workflow integration allowlist, then caller/thread context,
 * then the passthrough kill switch, then credential health. {@link
 * availableToolNames} keeps the `available === true` names; tool discovery
 * (#413) uses the `reason` to explain a strong-but-unavailable match instead of
 * silently dropping it; the dispatch floor calls {@link resolveToolAvailability},
 * which runs the same two phases in the same order.
 *
 * Two entry points, not an overload — {@link resolveToolAvailability} is the async
 * companion, and the sync/async split is forced: {@link availableToolNames} filters
 * a whole catalog synchronously and cannot await. The choice rule, stated once
 * here: hold a snapshot already, or need answers for more than one tool, and you
 * want THIS one (a single credential read covers the whole catalog). Hold exactly
 * one tool and no snapshot — the dispatch floor — and you want the companion.
 */
export function evaluateToolAvailability(
  snapshot: IntegrationAvailabilitySnapshot,
  tool: RegisteredTool,
  allowed: ReadonlySet<string>,
  context: ToolAvailabilityContext,
): ToolAvailabilityResult {
  const contextResult = evaluateRunContextGates(tool, allowed, context);
  if (!contextResult.available) return contextResult;
  return evaluateSnapshotGates(snapshot, tool);
}

/**
 * {@link evaluateToolAvailability} for a caller holding one tool and no
 * snapshot — the dispatch floor, which evaluates a single call and must read the
 * LIVE credential/preference state so a revoked grant or a kill switch flipped
 * mid-run can't be bypassed by a surface built at turn start.
 *
 * `loadSnapshot` is invoked at most once and only when the snapshot phase could
 * actually reject, so a `system.*` or `mcp.*` call costs no database read. Both
 * entry points run the identical gates in the identical order: adding a gate to
 * one phase reaches every surface.
 */
export async function resolveToolAvailability(args: {
  tool: RegisteredTool;
  allowed: ReadonlySet<string>;
  context: ToolAvailabilityContext;
  loadSnapshot: () => Promise<IntegrationAvailabilitySnapshot>;
}): Promise<ToolAvailabilityResult> {
  const contextResult = evaluateRunContextGates(args.tool, args.allowed, args.context);
  if (!contextResult.available) return contextResult;
  if (!readsAvailabilitySnapshot(args.tool)) return { available: true };
  return evaluateSnapshotGates(await args.loadSnapshot(), args.tool);
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
