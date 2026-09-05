import {
  CREDENTIAL_PROVIDERS,
  credentialAccountLabel,
  credentialProviderOf,
  credentialSatisfies,
  INTEGRATIONS,
  isCredentialProvider,
  isPassthroughPreferenceOn,
  LIVE_PROVIDER_SLUGS,
  LIVE_PROVIDERS,
  PASSTHROUGH_PREFERENCE_KEYS,
  projectSlugs,
  toStringArray,
  type CredentialProvider,
  type CredentialSpec,
  type IntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type IntegrationConnection,
  type IntegrationStatus,
  type LoadableIntegrationSlug,
  type ProviderAvailability,
  type SupportedPassthroughSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  integrationCredentials,
  userPreferences,
  type IntegrationCredential,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray } from "drizzle-orm";

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
 * window it would read back the state the user just changed. The read does not
 * evict the memo either, so for up to {@link AVAILABILITY_MEMO_TTL_MS} after a
 * disconnect the web can say "Connect" while a dispatch already in flight still
 * reads `active`; inside that window the call fails with the provider's own auth
 * error, which is the memo's documented trade. The join lives here, beside the
 * snapshot the dispatch floor reads, so the two consume one row read and one
 * connected rule ({@link resolveIntegrationAvailability}) and cannot disagree on
 * which rows count.
 */
export async function readIntegrationStatus(userId: string): Promise<IntegrationStatus> {
  const byProvider = await loadCredentialRowsByProvider(userId);
  const rowsOf = (provider: CredentialProvider): readonly AvailabilityRow[] =>
    byProvider.get(provider) ?? [];

  const integrations = projectSlugs(LIVE_PROVIDER_SLUGS, (slug): IntegrationConnection => {
    const spec = INTEGRATIONS[slug].credential;
    const rows = rowsOf(credentialProviderOf(slug));
    return {
      health: resolveIntegrationAvailability(spec, rows).health,
      accounts: rows
        .filter((row) => credentialSatisfies(spec, row))
        .map((row) => ({
          id: row.credentialId,
          accountLabel: credentialAccountLabel(row) ?? row.accountId,
          connectedAt: row.createdAt.toISOString(),
        })),
    };
  });

  // A provider appears iff it holds an `active` row. Each row carries the
  // provider's live slugs whose rule it fails: the Google scopes the user
  // unchecked, or the GitHub App installation a classic-OAuth row never had.
  const providers: IntegrationStatus["providers"] = {};
  for (const provider of CREDENTIAL_PROVIDERS) {
    const active = rowsOf(provider).filter((row) => row.status === "active");
    if (active.length === 0) continue;
    const entries = LIVE_PROVIDERS.filter((entry) => entry.provider === provider);
    providers[provider] = active.map((row) => ({
      accountId: row.accountId,
      accountLabel: credentialAccountLabel(row),
      missing: entries
        .filter((entry) => !credentialSatisfies(entry.credential, row))
        .map((entry) => entry.slug),
    }));
  }

  return { integrations, providers };
}

/**
 * A {@link ProviderAvailability} row plus the timestamp the web shows as
 * "connected at". Distinct from the `CredentialRow` of
 * `@alfred/integrations/google`, which is that provider's token row.
 */
type AvailabilityRow = ProviderAvailability & Pick<IntegrationCredential, "createdAt">;

/**
 * Every credential row of one user, grouped by `integration_credentials.provider`
 * and ordered oldest first (`created_at`, then `id` for two rows in one instant).
 * The one row read both the availability snapshot and the web status consume, so
 * "the first row" means the same row to both: the account connected first.
 */
async function loadCredentialRowsByProvider(
  userId: string,
): Promise<Map<CredentialProvider, AvailabilityRow[]>> {
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
    .where(eq(integrationCredentials.userId, userId))
    .orderBy(asc(integrationCredentials.createdAt), asc(integrationCredentials.id));

  const byProvider = new Map<CredentialProvider, AvailabilityRow[]>();
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
  spec: CredentialSpec,
  providerRows: readonly ProviderAvailability[],
): IntegrationAvailability {
  if (providerRows.length === 0) return { health: null, accountLabel: null };
  const active = providerRows.find((row) => credentialSatisfies(spec, row));
  return {
    health: active ? "active" : "needs_reauth",
    accountLabel: active ? credentialAccountLabel(active) : null,
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
      resolveIntegrationAvailability(entry.credential, byProvider.get(entry.provider) ?? []),
    );
  }
  // The rows carry `createdAt` past the `ProviderAvailability` the snapshot
  // declares: structural widening, read by nothing on the dispatch side.
  return { integrations: availability, providers: byProvider, passthroughEnabled };
}
