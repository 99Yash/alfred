import {
  GOOGLE_SLUGS,
  INTEGRATIONS,
  integrationStatusSchema,
  isLiveProviderSlug,
  type ConnectedAccount,
  type CredentialProvider,
  type DeliveryAlert,
  type GoogleSlug,
  type IntegrationConnection,
  type IntegrationStatus,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { client, parseEdenBody } from "~/lib/eden";
import { INTEGRATION_PAGES, type IntegrationPage } from "~/lib/integrations/integrations";

/** A catalog page with `GET /api/integrations` credential state laid over it. */
export interface ResolvedIntegration extends IntegrationPage {
  connectedAccounts: ReadonlyArray<ConnectedAccount>;
}

export const INTEGRATION_STATUS_QUERY_KEY = ["integrations", "status"] as const;

/** The server's join of registry, credentials, and connected rule (ADR-0093). Until it succeeds, nothing reads as connected. */
function useIntegrationStatus() {
  return useQuery<IntegrationStatus>({
    queryKey: INTEGRATION_STATUS_QUERY_KEY,
    queryFn: async () => {
      const res = await client.api.integrations.get();

      if (res.error) throw new Error(`integration status failed (${res.error.status})`);

      // `parseEdenBody` undoes Eden's date revival. A bad field is a contract break, so throw.
      return parseEdenBody(integrationStatusSchema, res.data);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** A switch, not a template string, because each Eden path is a separate typed client. */
async function deleteProviderCredential(provider: CredentialProvider, id: string) {
  switch (provider) {
    case "google":
      return client.api.integrations.google({ id }).delete();
    case "github":
      return client.api.integrations.github({ id }).delete();
    case "notion":
      return client.api.integrations.notion({ id }).delete();
    case "sentry":
      return client.api.integrations.sentry({ id }).delete();
    case "vercel":
      return client.api.integrations.vercel({ id }).delete();
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unhandled credential provider: ${String(_exhaustive)}`);
    }
  }
}

/** Throws on a non-2xx so the caller can toast. */
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
 * Label of the first connected account, or `null`. Onboarding uses it, not the
 * `?*_connected` param, because a second connect would blank the first badge.
 */
export function useConnectedAccountLabel(provider: CredentialProvider): string | null {
  const { data } = useIntegrationStatus();
  const first = data?.providers[provider]?.[0];

  return first ? (first.accountLabel ?? first.accountId) : null;
}

export interface ResolvedIntegrationsResult {
  integrations: ReadonlyArray<ResolvedIntegration>;
  /**
   * False until the read succeeds once. A failed read looks like "nothing connected",
   * so surfaces that gate on connection state must wait for this.
   */
  ready: boolean;
}

/**
 * A live page is `"connected"` when its entry reports `active` health
 * (the server applies `credentialSatisfies`). A planned page keeps its catalog status.
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
 * Google's consent screen lets the user uncheck scopes. A product is a gap
 * when every active Google row misses it.
 */
export interface GoogleScopeGaps {
  connected: boolean;
  accountLabel: string | null;
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
 * A pre-App OAuth credential (ADR-0052) is `active` but has no `installation_id`,
 * so no webhooks flow. The server marks it with `github` in `missing`.
 */
export interface GithubReconnect {
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

/**
 * Integrations that stopped delivering events (ADR-0100). All filtering is
 * server-side, so the banner and the email agree.
 */
export function useDeliveryAlerts(): readonly DeliveryAlert[] {
  const { data } = useIntegrationStatus();

  return data?.deliveryAlerts ?? EMPTY_ALERTS;
}

/** Stable identity for callers' `useMemo`. */
const EMPTY_ALERTS: readonly DeliveryAlert[] = [];
