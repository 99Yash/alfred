import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "~/lib/eden";
import {
  INTEGRATION_PROVIDERS,
  PROVIDER_BACKEND,
  PROVIDER_REQUIRED_SCOPES,
  type IntegrationProvider,
} from "~/lib/integrations";

export interface CredentialRow {
  id: string;
  accountId: string;
  accountLabel: string | null;
  status: string;
  scopes: ReadonlyArray<string>;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
}

/**
 * Legacy alias for back-compat with callers still on the Google-only
 * shape. New code should use `CredentialRow`.
 */
export type GoogleCredentialRow = CredentialRow;

export interface ConnectedAccount {
  accountLabel: string;
  connectedAt: string;
}

/**
 * The provider tile a UI surface actually wants to render: the static
 * catalog entry overlaid with whatever the user's `integration_credentials`
 * rows tell us. Components keep consuming the standard `IntegrationProvider`
 * shape — `status` / `actionLabel` just reflect real DB state now.
 */
export interface ResolvedIntegration extends IntegrationProvider {
  /** Accounts the user has connected for this provider. */
  connectedAccounts: ReadonlyArray<ConnectedAccount>;
}

/**
 * Fetch credential rows for a single provider backend. Returns `[]` on
 * any error (unauthenticated, network, …) so callers can render the
 * honest "not connected" state without a special-case loading branch.
 */
function useProviderCredentials(backend: "google" | "github") {
  return useQuery<ReadonlyArray<CredentialRow>>({
    queryKey: ["integrations", backend, "credentials"],
    queryFn: async () => {
      const res =
        backend === "google"
          ? await client.api.integrations.google.credentials.get()
          : await client.api.integrations.github.credentials.get();
      if (res.error || !res.data) return [];
      const raw = res.data.credentials as ReadonlyArray<Record<string, unknown>>;
      return raw.map((r) => ({
        id: String(r.id),
        accountId: String(r.accountId),
        accountLabel: typeof r.accountLabel === "string" ? r.accountLabel : null,
        status: String(r.status),
        scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
        expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
        lastRefreshedAt: typeof r.lastRefreshedAt === "string" ? r.lastRefreshedAt : null,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
      }));
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

function useGoogleCredentials() {
  return useProviderCredentials("google");
}

function useGithubCredentials() {
  return useProviderCredentials("github");
}

/**
 * Resolve every catalog provider against the user's real credentials.
 * Each catalog entry consults the credential set for its declared
 * backend (per `PROVIDER_BACKEND`) and flips to `"connected"` iff an
 * active row carries every required scope.
 */
export function useResolvedIntegrations(): ReadonlyArray<ResolvedIntegration> {
  const { data: googleCreds } = useGoogleCredentials();
  const { data: githubCreds } = useGithubCredentials();
  return useMemo(
    () =>
      INTEGRATION_PROVIDERS.map((p) => {
        const backend = PROVIDER_BACKEND[p.id];
        const creds =
          backend === "google" ? googleCreds : backend === "github" ? githubCreds : undefined;
        return resolveOne(p, creds);
      }),
    [googleCreds, githubCreds],
  );
}

export function useResolvedIntegration(providerId: string): ResolvedIntegration | undefined {
  const all = useResolvedIntegrations();
  return all.find((p) => p.id === providerId);
}

function resolveOne(
  provider: IntegrationProvider,
  creds: ReadonlyArray<CredentialRow> | undefined,
): ResolvedIntegration {
  const required = PROVIDER_REQUIRED_SCOPES[provider.id];
  if (!required) {
    return { ...provider, connectedAccounts: [] };
  }
  if (!creds) {
    return { ...provider, connectedAccounts: [] };
  }
  const matching = creds.filter(
    (c) => c.status === "active" && required.every((s) => c.scopes.includes(s)),
  );
  if (matching.length === 0) {
    return { ...provider, connectedAccounts: [] };
  }
  return {
    ...provider,
    status: "connected",
    actionLabel: "Manage",
    connectedAccounts: matching.map((c) => ({
      accountLabel: c.accountLabel ?? c.accountId,
      connectedAt: c.createdAt,
    })),
  };
}
