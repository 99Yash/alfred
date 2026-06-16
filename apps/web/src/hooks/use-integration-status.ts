import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "~/lib/eden";
import {
  INTEGRATION_PROVIDERS,
  PROVIDER_BACKEND,
  PROVIDER_REQUIRED_SCOPES,
  type ProviderScopeRequirement,
  type IntegrationProvider,
} from "~/lib/integrations";

export interface CredentialRow {
  id: string;
  accountId: string;
  accountLabel: string | null;
  status: string;
  scopes: ReadonlyArray<string>;
  /** GitHub App installation id; null on legacy classic-OAuth rows. */
  installationId: string | null;
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
        installationId: typeof r.installationId === "string" ? r.installationId : null,
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
 * The display label of the first active credential for a backend, or
 * `null` if none. Used by onboarding to keep the Google and GitHub
 * "connected as …" badges live independently of the `?*_connected` URL
 * param — each provider's OAuth callback only carries its own param, so a
 * second connect would otherwise blank the first badge.
 */
export function useConnectedAccountLabel(backend: "google" | "github"): string | null {
  const { data } = useProviderCredentials(backend);
  const active = (data ?? []).find((c) => c.status === "active");
  return active?.accountLabel ?? active?.accountId ?? null;
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
  if (!creds) {
    return { ...provider, connectedAccounts: [] };
  }
  const matching =
    PROVIDER_BACKEND[provider.id] === "github"
      ? // GitHub App installs carry no OAuth scopes — App *permissions*
        // (metadata/PRs/issues/contents, ADR-0052) never flow into the
        // credential's `scopes` array, so the scope-completeness probe Google
        // uses can't apply. A GitHub credential is connected when it's active
        // and the App is installed (installation_id present). Legacy
        // classic-OAuth rows (active but no installation_id) can't mint
        // installation tokens, so they read as not-connected here and the
        // reconnect nag (`useGithubNeedsReconnect`) drives the upgrade.
        creds.filter((c) => c.status === "active" && c.installationId)
      : matchByScopes(provider, creds);
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

/**
 * Partial-grant detector for the scope-completeness banner. Alfred's
 * onboarding requests the full Google grant in one consent, but Google's
 * consent screen lets the user *uncheck* individual scopes — so a Google
 * account can be connected yet missing the scopes a feature needs. This
 * surfaces that gap: which Google-backed providers an active credential
 * fails to fully cover. Empty `missing` = nothing to nag about. Mirrors
 * dimension's `checkGoogleScopesComplete`.
 */
export interface GoogleScopeGaps {
  /** At least one active Google credential exists. */
  connected: boolean;
  accountLabel: string | null;
  /** Google-backed providers an active credential does not fully scope. */
  missing: ReadonlyArray<{ providerId: string; name: string }>;
}

export function useGoogleScopeGaps(): GoogleScopeGaps {
  const { data: googleCreds } = useGoogleCredentials();
  return useMemo(() => {
    const active = (googleCreds ?? []).filter((c) => c.status === "active");
    if (active.length === 0) {
      return { connected: false, accountLabel: null, missing: [] };
    }
    const missing = INTEGRATION_PROVIDERS.flatMap((p) => {
      if (PROVIDER_BACKEND[p.id] !== "google") return [];
      const required = PROVIDER_REQUIRED_SCOPES[p.id];
      if (!required) return [];
      // Missing iff no active credential carries every required scope.
      if (active.some((c) => required.every((r) => meetsScopeRequirement(c.scopes, r)))) return [];
      return [{ providerId: p.id, name: p.name }];
    });
    return { connected: true, accountLabel: active[0]?.accountLabel ?? null, missing };
  }, [googleCreds]);
}

/**
 * GitHub App migration nag. A classic-OAuth credential (connected before the
 * GitHub App migration, ADR-0052) is still `active` but carries no
 * `installation_id`, so installation-token minting fails and no activity
 * webhooks flow. Reconnecting runs the one-click Install & Authorize, which
 * writes the `installation_id`. Returns `needsReconnect` only when such a
 * stale row exists — i.e. there's something to nag about. Mirrors
 * `useGoogleScopeGaps`.
 */
export interface GithubReconnect {
  /** An active GitHub credential is missing its App installation. */
  needsReconnect: boolean;
  accountLabel: string | null;
}

export function useGithubNeedsReconnect(): GithubReconnect {
  const { data: githubCreds } = useGithubCredentials();
  return useMemo(() => {
    const stale = (githubCreds ?? []).find((c) => c.status === "active" && !c.installationId);
    return {
      needsReconnect: Boolean(stale),
      accountLabel: stale?.accountLabel ?? null,
    };
  }, [githubCreds]);
}

/**
 * Scope-based connection probe (Google providers): an active credential
 * counts only if it carries every required scope. A provider with no scope
 * requirement has no live backend yet, so nothing matches.
 */
function matchByScopes(
  provider: IntegrationProvider,
  creds: ReadonlyArray<CredentialRow>,
): ReadonlyArray<CredentialRow> {
  const required = PROVIDER_REQUIRED_SCOPES[provider.id];
  if (!required) return [];
  return creds.filter(
    (c) => c.status === "active" && required.every((r) => meetsScopeRequirement(c.scopes, r)),
  );
}

function meetsScopeRequirement(
  scopes: ReadonlyArray<string>,
  requirement: ProviderScopeRequirement,
): boolean {
  return typeof requirement === "string"
    ? scopes.includes(requirement)
    : requirement.some((scope) => scopes.includes(scope));
}
