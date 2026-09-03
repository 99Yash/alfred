import {
  isCredentialProvider,
  isPassthroughPreferenceOn,
  LIVE_PROVIDERS,
  PASSTHROUGH_PREFERENCE_KEYS,
  toStringArray,
  type CredentialProvider,
  type IntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type LiveProviderEntry,
  type LoadableIntegrationSlug,
  type ProviderAvailability,
  type SupportedPassthroughSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, userPreferences } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

/**
 * The scopes that prove a live provider is connected (ADR-0093). Only a Google
 * grant can be partial — the consent screen lets the user uncheck scopes — so
 * only a `google_oauth` credential names any; for every other shape an active
 * row is the proof and the list is empty.
 */
function connectedScopes(entry: LiveProviderEntry): readonly string[] {
  return entry.credential.shape === "google_oauth" ? entry.credential.anyOfScopes : [];
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
  const passthroughEnabled = new Map<SupportedPassthroughSlug, boolean>();
  // SAFETY: PASSTHROUGH_PREFERENCE_KEYS is keyed by SupportedPassthroughSlug
  // with string preference keys, so Object.entries yields exactly these tuples.
  for (const [slug, key] of Object.entries(PASSTHROUGH_PREFERENCE_KEYS) as [
    SupportedPassthroughSlug,
    string,
  ][]) {
    passthroughEnabled.set(slug, isPassthroughPreferenceOn(prefByKey.get(key)));
  }

  const byProvider = new Map<CredentialProvider, ProviderAvailability[]>();
  for (const row of rows) {
    // The column is CHECK-constrained to this vocabulary; the guard is the read
    // boundary's own proof, so a row the constraint predates cannot poison a
    // provider key that nothing else reads.
    if (!isCredentialProvider(row.provider)) continue;
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
  for (const entry of LIVE_PROVIDERS) {
    const providerRows = byProvider.get(entry.provider);
    if (!providerRows || providerRows.length === 0) {
      availability.set(entry.slug, { health: null, accountLabel: null });
      continue;
    }
    const anyOfScopes = connectedScopes(entry);
    const active = providerRows.find(
      (row) =>
        row.status === "active" &&
        (anyOfScopes.length === 0 || anyOfScopes.some((scope) => row.scopes.has(scope))),
    );
    availability.set(entry.slug, {
      health: active ? "active" : "needs_reauth",
      accountLabel: active?.accountLabel?.trim() || null,
    });
  }
  return { integrations: availability, providers: byProvider, passthroughEnabled };
}
