import {
  CREDENTIAL_PROVIDERS,
  credentialSatisfies,
  isCredentialProvider,
  isPassthroughPreferenceOn,
  LIVE_PROVIDERS,
  PASSTHROUGH_PREFERENCE_KEYS,
  toStringArray,
  type CredentialProvider,
  type IntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type IntegrationStatus,
  type LiveProviderEntry,
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

/**
 * `GET /api/integrations`: the registry joined with the user's credentials and
 * resolved through each entry's connected rule, in the shape the web renders.
 *
 * It reads the rows directly instead of through {@link readIntegrationAvailability}:
 * the web refetches right after a connect or a disconnect, and inside the memo's
 * window it would read back the state the user just changed. The join lives here,
 * beside the snapshot the dispatch floor reads, so the two consume one row read
 * and one connected rule ({@link resolveIntegrationAvailability}) and cannot
 * disagree on which rows count.
 */
export async function readIntegrationStatus(userId: string): Promise<IntegrationStatus> {
  const byProvider = await loadCredentialRowsByProvider(userId);

  const integrations = LIVE_PROVIDERS.map((entry) => {
    const rows = byProvider.get(entry.provider) ?? [];
    const { health } = resolveIntegrationAvailability(entry, rows);
    const accounts = rows
      .filter((row) => credentialSatisfies(entry.credential, row))
      .map((row) => ({
        id: row.credentialId,
        accountLabel: row.accountLabel ?? row.accountId,
        connectedAt: row.createdAt.toISOString(),
      }));
    return { slug: entry.slug, health, accounts };
  });

  // A provider appears iff it holds an active row. `missing` is the provider's
  // live slugs no active row proves: the Google scopes the user unchecked, or the
  // GitHub App installation a classic-OAuth row never had.
  const providers = CREDENTIAL_PROVIDERS.flatMap((provider) => {
    const active = (byProvider.get(provider) ?? []).filter((row) => row.status === "active");
    const first = active[0];
    if (!first) return [];
    const missing = LIVE_PROVIDERS.filter(
      (entry) =>
        entry.provider === provider &&
        !active.some((row) => credentialSatisfies(entry.credential, row)),
    ).map((entry) => entry.slug);
    return [{ provider, accountId: first.accountId, accountLabel: first.accountLabel, missing }];
  });

  return { integrations, providers };
}

/** A {@link ProviderAvailability} row plus the timestamp the web shows as "connected at". */
interface CredentialRow extends ProviderAvailability {
  createdAt: Date;
}

/**
 * Every credential row of one user, grouped by `integration_credentials.provider`.
 * The one row read both the availability snapshot and the web status consume.
 */
async function loadCredentialRowsByProvider(
  userId: string,
): Promise<Map<CredentialProvider, CredentialRow[]>> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      provider: integrationCredentials.provider,
      accountId: integrationCredentials.accountId,
      status: integrationCredentials.status,
      scopes: integrationCredentials.scopes,
      installationId: integrationCredentials.installationId,
      accountLabel: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
      createdAt: integrationCredentials.createdAt,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.userId, userId));

  const byProvider = new Map<CredentialProvider, CredentialRow[]>();
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
      createdAt: row.createdAt,
    });
    byProvider.set(row.provider, list);
  }
  return byProvider;
}

/**
 * The entry's connected rule (ADR-0093) over its provider's rows: `null` health
 * with no rows, `active` when one row satisfies the rule, `needs_reauth` when
 * rows exist but none does, so a legacy GitHub row without an installation reads
 * `needs_reauth` here as it does on the web.
 */
function resolveIntegrationAvailability(
  entry: LiveProviderEntry,
  providerRows: readonly ProviderAvailability[],
): IntegrationAvailability {
  if (providerRows.length === 0) return { health: null, accountLabel: null };
  const active = providerRows.find((row) => credentialSatisfies(entry.credential, row));
  return {
    health: active ? "active" : "needs_reauth",
    accountLabel: active?.accountLabel?.trim() || null,
  };
}

async function loadIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const passthroughKeys = Object.values(PASSTHROUGH_PREFERENCE_KEYS);
  const [byProvider, prefRows] = await Promise.all([
    loadCredentialRowsByProvider(userId),
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

  const availability = new Map<LoadableIntegrationSlug, IntegrationAvailability>();
  for (const entry of LIVE_PROVIDERS) {
    availability.set(
      entry.slug,
      resolveIntegrationAvailability(entry, byProvider.get(entry.provider) ?? []),
    );
  }
  return { integrations: availability, providers: byProvider, passthroughEnabled };
}
