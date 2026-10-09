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
  selectGithubAccountRow,
  toMessage,
  toStringArray,
  type CredentialProvider,
  type CredentialRowsByProvider,
  type CredentialSpec,
  type DeliveryAlert,
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
import { gmailPushStaleStatus, readGmailDeliveryFacts } from "./ingestion/gmail-delivery-facts";
import { readDeliveryAlerts, toDeliveryAlerts } from "./delivery-alerts";

/**
 * Short on purpose: the dispatch floor must see a revoked grant. Inside the window,
 * a stale call just fails with the provider's auth error.
 */
const AVAILABILITY_MEMO_TTL_MS = 3_000;

interface AvailabilityMemoEntry {
  readAt: number;
  snapshot: Promise<IntegrationAvailabilitySnapshot>;
}

const availabilityMemo = new Map<string, AvailabilityMemoEntry>();

/**
 * Per-integration health, memoized per user for {@link AVAILABILITY_MEMO_TTL_MS}.
 * The dispatch floor reads it on every call. Caching the promise merges concurrent callers;
 * a rejected read is evicted. Expiry is by time, so writers need not bust it.
 */
export function readIntegrationAvailability(
  userId: string,
): Promise<IntegrationAvailabilitySnapshot> {
  const now = Date.now();
  const cached = availabilityMemo.get(userId);

  if (cached && now - cached.readAt < AVAILABILITY_MEMO_TTL_MS) return cached.snapshot;

  // Nothing else removes entries, so this sweep bounds the map.
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
 * `GET /api/integrations`. Skips the memo: the web refetches right after a
 * connect or disconnect and must see the change.
 */
export async function readIntegrationStatus(userId: string): Promise<IntegrationStatus> {
  const byProvider = await loadCredentialRowsByProvider(userId);

  const [gmailDelivery, deliveryAlerts] = await Promise.all([
    readGmailDeliveryFacts(userId),
    readWireDeliveryAlerts(userId, byProvider),
  ]);

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
          pushStale: gmailPushStaleStatus(gmailDelivery, row, slug),
        })),
    };
  });

  // Only providers with an `active` row. `missing` lists the live slugs each row fails.
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

  return { integrations, providers, deliveryAlerts };
}

/**
 * Delivery alerts (ADR-0100), or none on failure. A throw here must not blank
 * every integration tile. Gmail's facts are read twice per poll, to keep the
 * health reader free of a Gmail parameter.
 */
async function readWireDeliveryAlerts(
  userId: string,
  rows: CredentialRowsByProvider,
): Promise<DeliveryAlert[]> {
  try {
    return toDeliveryAlerts(await readDeliveryAlerts(userId, rows));
  } catch (err) {
    console.error(
      `[integrations] inbound delivery health read failed for user=${userId}: ${toMessage(err)}`,
    );

    return [];
  }
}

/** Not the `CredentialRow` of `@alfred/integrations/google`, which is a token row. */
type AvailabilityRow = ProviderAvailability & Pick<IntegrationCredential, "createdAt">;

/** Oldest first, so "the first row" is the first connected account for every reader. */
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
    // A miss is registry-versus-CHECK drift. Fail loud; do not hide a connected provider.
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

/** The connected rule (ADR-0093): no rows is `null`, rows that all fail it are `needs_reauth`. */
function resolveIntegrationAvailability(
  spec: CredentialSpec,
  providerRows: readonly ProviderAvailability[],
): IntegrationAvailability {
  if (providerRows.length === 0) return { health: null, accountLabel: null };
  const satisfying = providerRows.filter((row) => credentialSatisfies(spec, row));
  // An org install leaves GitHub with a second row, so the card names the row the tools
  // would use rather than the first one that satisfies the rule.
  const active = spec.shape === "github_app" ? selectGithubAccountRow(satisfying) : satisfying[0];

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

  // SAFETY: PASSTHROUGH_PREFERENCE_KEYS is keyed by SupportedPassthroughSlug with string values.
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

  return { integrations: availability, providers: byProvider, passthroughEnabled };
}
