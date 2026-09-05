import {
  GOOGLE_SLUGS,
  INTEGRATIONS,
  integrationStatusSchema,
  isLiveProviderSlug,
  type ConnectedAccount,
  type CredentialProvider,
  type GoogleSlug,
  type IntegrationConnection,
  type IntegrationStatus,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { client, parseEdenBody } from "~/lib/eden";
import { INTEGRATION_PAGES, type IntegrationPage } from "~/lib/integrations/integrations";

/**
 * The provider tile a UI surface actually wants to render: the static
 * catalog page overlaid with what `GET /api/integrations` says about the
 * user's credentials. Components keep consuming the standard `IntegrationPage`
 * shape — `status` / `actionLabel` just reflect real DB state now.
 */
export interface ResolvedIntegration extends IntegrationPage {
  /** Accounts the user has connected for this provider. */
  connectedAccounts: ReadonlyArray<ConnectedAccount>;
}

/** The one query key of the status read; the connect and disconnect flows invalidate it. */
export const INTEGRATION_STATUS_QUERY_KEY = ["integrations", "status"] as const;

/**
 * The server-side join of registry, credentials, and connected rule (ADR-0093),
 * fetched once for every surface. A request failure throws so react-query
 * retries and refetches on focus; until it succeeds `data` is undefined and
 * every consumer reads the catalog with nothing connected.
 */
function useIntegrationStatus() {
  return useQuery<IntegrationStatus>({
    queryKey: INTEGRATION_STATUS_QUERY_KEY,
    queryFn: async () => {
      const res = await client.api.integrations.get();
      if (res.error) throw new Error(`integration status failed (${res.error.status})`);
      // The body is one document from one producer the compiler pins to this
      // schema; `parseEdenBody` undoes Eden's date revival, and a field that
      // fails is a contract break to surface, not a stray row to skip.
      return parseEdenBody(integrationStatusSchema, res.data);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Disconnect a single credential row for a provider. Each provider exposes the
 * same `DELETE /:id` shape (see the integration route files); the only thing
 * that varies is which provider namespace we hit. The switch is Eden mechanics:
 * each case is a typed client path, so it stays a switch rather than a template
 * string.
 */
async function deleteProviderCredential(provider: CredentialProvider, id: string) {
  switch (provider) {
    case "google":
      return client.api.integrations.google({ id }).delete();
    case "github":
      return client.api.integrations.github({ id }).delete();
    case "notion":
      return client.api.integrations.notion({ id }).delete();
    case "railway":
      return client.api.integrations.railway({ id }).delete();
    case "vercel":
      return client.api.integrations.vercel({ id }).delete();
    default: {
      // A CredentialProvider without a case here is a compile error, not a
      // silent `undefined` return.
      const _exhaustive: never = provider;
      throw new Error(`Unhandled credential provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Disconnect mutation for a credential provider. On success it invalidates the
 * status read so every tile re-resolves to the honest "not connected" state.
 * Throws on a non-2xx response so callers can surface a toast.
 */
export function useDisconnectIntegration(provider: CredentialProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await deleteProviderCredential(provider, id);
      if (res.error) throw new Error("Disconnect failed");
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUS_QUERY_KEY }),
  });
}

/**
 * The display label of the first active credential for a provider (the
 * account connected first), or `null` if none. Used by onboarding to keep the
 * Google and GitHub "connected as …" badges live independently of the
 * `?*_connected` URL param — each provider's OAuth callback only carries its
 * own param, so a second connect would otherwise blank the first badge.
 */
export function useConnectedAccountLabel(provider: CredentialProvider): string | null {
  const { data } = useIntegrationStatus();
  const first = data?.providers[provider]?.[0];
  return first ? (first.accountLabel ?? first.accountId) : null;
}

export interface ResolvedIntegrationsResult {
  integrations: ReadonlyArray<ResolvedIntegration>;
  /**
   * False until the status read has *succeeded* once. A request failure
   * throws, so a failed read leaves `data` undefined, which renders the same
   * as "nothing connected"; gating on settlement alone would fade a connected
   * provider to "Connect" during an API failure. Surfaces that *gate* on
   * connection state (the mention palette's connect nudges) hold stateless
   * rows through failures; surfaces that merely decorate (tiles, bars) can
   * ignore this flag and settle in place.
   */
  ready: boolean;
}

/**
 * Resolve every catalog page against the server's status read. A live page
 * flips to `"connected"` iff its entry reports `active` health, which the
 * server decides with the connected rule its registry entry declares
 * (`credentialSatisfies`: Google = active + one of the entry's scopes, GitHub
 * = active + App installation, bearer = active). The body is an exhaustive
 * record over the live slugs, so a live page always has an entry. A planned
 * page has none and keeps its catalog status.
 */
export function useResolvedIntegrationsWithReady(): ResolvedIntegrationsResult {
  const { data, isSuccess } = useIntegrationStatus();
  const integrations = useMemo(
    () =>
      INTEGRATION_PAGES.map((page) =>
        data && isLiveProviderSlug(page.slug)
          ? resolveOne(page, data.integrations[page.slug])
          : { ...page, connectedAccounts: [] },
      ),
    [data],
  );
  return useMemo(() => ({ integrations, ready: isSuccess }), [integrations, isSuccess]);
}

export function useResolvedIntegrations(): ReadonlyArray<ResolvedIntegration> {
  return useResolvedIntegrationsWithReady().integrations;
}

export function useResolvedIntegration(slug: string): ResolvedIntegration | undefined {
  const all = useResolvedIntegrations();
  return all.find((p) => p.slug === slug);
}

/** Overlay the entry that proves `page` connected; anything else leaves the catalog reading in place. */
function resolveOne(page: IntegrationPage, connection: IntegrationConnection): ResolvedIntegration {
  if (connection.health !== "active") {
    return { ...page, connectedAccounts: [] };
  }
  return {
    ...page,
    status: "connected",
    actionLabel: "Manage",
    connectedAccounts: connection.accounts,
  };
}

/**
 * Partial-grant detector for the scope-completeness banner. Alfred's
 * onboarding requests the full Google grant in one consent, but Google's
 * consent screen lets the user *uncheck* individual scopes — so a Google
 * account can be connected yet missing the scopes a feature needs. The server
 * reports, per active Google row, the Google slugs that row's scopes fail to
 * prove (`missing`); a product is a gap iff every active row misses it, the
 * same predicate the tiles use. Empty `missing` = nothing to nag about.
 * Mirrors dimension's `checkGoogleScopesComplete`.
 */
export interface GoogleScopeGaps {
  /** At least one active Google credential exists. */
  connected: boolean;
  accountLabel: string | null;
  /** Google products no active credential scopes. */
  missing: ReadonlyArray<{ slug: GoogleSlug; name: string }>;
}

export function useGoogleScopeGaps(): GoogleScopeGaps {
  const { data } = useIntegrationStatus();
  return useMemo(() => {
    const active = data?.providers.google;
    const first = active?.[0];
    if (!active || !first) {
      return { connected: false, accountLabel: null, missing: [] };
    }
    const missing = GOOGLE_SLUGS.filter((slug) =>
      active.every((row) => row.missing.includes(slug)),
    ).map((slug) => ({ slug, name: INTEGRATIONS[slug].displayName }));
    return { connected: true, accountLabel: first.accountLabel, missing };
  }, [data]);
}

/**
 * GitHub App migration nag. A classic-OAuth credential (connected before the
 * GitHub App migration, ADR-0052) is still `active` but carries no
 * `installation_id`, so installation-token minting fails and no activity
 * webhooks flow. Reconnecting runs the one-click Install & Authorize, which
 * writes the `installation_id`. The server reports such a row as an active
 * GitHub row with the `github` slug in its `missing` list; `needsReconnect` is
 * true only when one exists — i.e. there's something to nag about — and the
 * label names that row, not a healthy sibling. Mirrors `useGoogleScopeGaps`.
 */
export interface GithubReconnect {
  /** An active GitHub credential is missing its App installation. */
  needsReconnect: boolean;
  accountLabel: string | null;
}

export function useGithubNeedsReconnect(): GithubReconnect {
  const { data } = useIntegrationStatus();
  return useMemo(() => {
    const stale = data?.providers.github?.find((row) => row.missing.includes("github"));
    return {
      needsReconnect: stale !== undefined,
      accountLabel: stale?.accountLabel ?? null,
    };
  }, [data]);
}
