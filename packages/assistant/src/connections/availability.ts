import {
  credentialSatisfies,
  isCredentialProvider,
  isPassthroughPreferenceOn,
  LIVE_PROVIDERS,
  PASSTHROUGH_PREFERENCE_KEYS,
  toStringArray,
  type CredentialProvider,
  type IntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type LoadableIntegrationSlug,
  type ProviderAvailability,
  type SupportedPassthroughSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, userPreferences } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

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
        installationId: integrationCredentials.installationId,
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
    // The column's type is the CHECK constraint's promise, and this is the one
    // read that consumes the value (every other read filters on it). A miss is
    // registry-versus-migration drift, so it fails loud instead of dropping the
    // row and reading a connected provider as absent.
    if (!isCredentialProvider(row.provider)) {
      throw new Error(
        `[availability] integration_credentials.provider ${JSON.stringify(row.provider)} is not a registry provider; the CHECK constraint and the registry disagree`,
      );
    }
    const list = byProvider.get(row.provider) ?? [];
    list.push({
      credentialId: row.id,
      accountId: row.accountId,
      status: row.status,
      scopes: new Set(toStringArray(row.scopes)),
      installationId: row.installationId,
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
    // The connected rule is the entry's own (ADR-0093): the same predicate the
    // web's connectedness probe calls, so a legacy GitHub row without an
    // installation reads `needs_reauth` here as it does there.
    const active = providerRows.find((row) => credentialSatisfies(entry.credential, row));
    availability.set(entry.slug, {
      health: active ? "active" : "needs_reauth",
      accountLabel: active?.accountLabel?.trim() || null,
    });
  }
  return { integrations: availability, providers: byProvider, passthroughEnabled };
}
