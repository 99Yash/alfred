import {
  credentialProviderOf,
  credentialRowSchema,
  credentialSatisfies,
  GOOGLE_SLUGS,
  INTEGRATIONS,
  isLiveProviderSlug,
  type CredentialProvider,
  type GoogleSlug,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { client } from "~/lib/eden";
import { INTEGRATION_PAGES, type IntegrationPage } from "~/lib/integrations/integrations";

/**
 * Eden Treaty revives ISO-shaped response strings into `Date` objects on the
 * client, so a timestamp the wire contract honestly types as `string` arrives
 * as a `Date` at runtime. A bare `z.string()` then fails, and because
 * `parseCredentialRows` drops any row that fails to parse, every connected
 * provider silently reads as "not connected". Accept both and flatten back to
 * the ISO string the contract promises. See the same trap in
 * `use-latest-briefing`'s `toDateKey()`.
 */
const edenTimestamp = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

/**
 * The web projection of the integration credential routes, derived from the
 * owning wire schema in `@alfred/contracts`. Two local deltas: the
 * provider-specific `installationId` (absent on bearer rows) normalizes to
 * null, and the timestamps absorb Eden's date revival — so consumers read one
 * shape.
 */
export const parsedCredentialRowSchema = credentialRowSchema.extend({
  installationId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  expiresAt: edenTimestamp.nullable(),
  lastRefreshedAt: edenTimestamp.nullable(),
  createdAt: edenTimestamp,
});
export type CredentialRow = z.infer<typeof parsedCredentialRowSchema>;

/** Parse each row independently so one malformed credential cannot hide valid siblings. */
export function parseCredentialRows(input: unknown): CredentialRow[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((row) => {
    const parsed = parsedCredentialRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface ConnectedAccount {
  /** `integration_credentials.id` — the disconnect target. */
  id: string;
  accountLabel: string;
  connectedAt: string;
}

/**
 * The provider tile a UI surface actually wants to render: the static
 * catalog page overlaid with whatever the user's `integration_credentials`
 * rows tell us. Components keep consuming the standard `IntegrationPage`
 * shape — `status` / `actionLabel` just reflect real DB state now.
 */
export interface ResolvedIntegration extends IntegrationPage {
  /** Accounts the user has connected for this provider. */
  connectedAccounts: ReadonlyArray<ConnectedAccount>;
}

/**
 * Fetch credential rows for one credential provider (the route family
 * `/api/integrations/<provider>`). The switch is Eden mechanics: each case is
 * a typed client path, so it stays a switch rather than a template string.
 * Returns `[]` on any error (unauthenticated, network, …) so callers can render
 * the honest "not connected" state without a special-case loading branch.
 */
async function fetchProviderCredentials(provider: CredentialProvider) {
  switch (provider) {
    case "google":
      return client.api.integrations.google.credentials.get();
    case "github":
      return client.api.integrations.github.credentials.get();
    case "notion":
      return client.api.integrations.notion.credentials.get();
    case "railway":
      return client.api.integrations.railway.credentials.get();
    case "vercel":
      return client.api.integrations.vercel.credentials.get();
    default: {
      // A CredentialProvider without a case here is a compile error, not a
      // silent `undefined` return.
      const _exhaustive: never = provider;
      throw new Error(`Unhandled credential provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Disconnect a single credential row for a provider. Each provider exposes the
 * same `DELETE /:id` shape (see the integration route files); the only thing
 * that varies is which provider namespace we hit. Mirrors the per-provider
 * dispatch in `fetchProviderCredentials`.
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
      const _exhaustive: never = provider;
      throw new Error(`Unhandled credential provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Disconnect mutation for a credential provider. On success it invalidates that
 * provider's credential query so every tile bound to it re-resolves to the
 * honest "not connected" state. Throws on a non-2xx response so callers can
 * surface a toast.
 */
export function useDisconnectIntegration(provider: CredentialProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await deleteProviderCredential(provider, id);
      if (res.error) throw new Error("Disconnect failed");
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: credentialsQueryKey(provider) }),
  });
}

/** The query key of one provider's credential rows; the connect flows invalidate it. */
export function credentialsQueryKey(provider: CredentialProvider) {
  return ["integrations", provider, "credentials"] as const;
}

function useProviderCredentials(provider: CredentialProvider) {
  return useQuery<ReadonlyArray<CredentialRow>>({
    queryKey: credentialsQueryKey(provider),
    queryFn: async () => {
      const res = await fetchProviderCredentials(provider);
      if (res.error || !res.data) return [];
      return parseCredentialRows(res.data.credentials);
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

function useNotionCredentials() {
  return useProviderCredentials("notion");
}

function useRailwayCredentials() {
  return useProviderCredentials("railway");
}

function useVercelCredentials() {
  return useProviderCredentials("vercel");
}

/**
 * The display label of the first active credential for a provider, or
 * `null` if none. Used by onboarding to keep the Google and GitHub
 * "connected as …" badges live independently of the `?*_connected` URL
 * param — each provider's OAuth callback only carries its own param, so a
 * second connect would otherwise blank the first badge.
 */
export function useConnectedAccountLabel(provider: CredentialProvider): string | null {
  const { data } = useProviderCredentials(provider);
  const active = (data ?? []).find((c) => c.status === "active");
  return active?.accountLabel ?? active?.accountId ?? null;
}

export interface ResolvedIntegrationsResult {
  integrations: ReadonlyArray<ResolvedIntegration>;
  /**
   * False until every provider credential query has *succeeded* once — not
   * merely settled. The fetchers collapse any request failure to `[]`, which
   * is indistinguishable from "nothing connected", so gating on settlement
   * alone would fade a connected provider to "Connect" during an API
   * failure. Surfaces that *gate* on connection state (the mention palette's
   * connect nudges) hold stateless rows through failures; surfaces that
   * merely decorate (tiles, bars) can ignore this flag and settle in place.
   */
  ready: boolean;
}

/**
 * Resolve every catalog page against the user's real credentials. Each live
 * page consults the credential rows of its provider (`credentialProviderOf`)
 * and flips to `"connected"` iff one row satisfies the connected rule its
 * registry entry declares (`credentialSatisfies`: Google = active + one of
 * the entry's scopes, GitHub = active + App installation, bearer = active).
 * A planned page has no credential to probe and keeps its catalog status.
 */
export function useResolvedIntegrationsWithReady(): ResolvedIntegrationsResult {
  const google = useGoogleCredentials();
  const github = useGithubCredentials();
  const notion = useNotionCredentials();
  const railway = useRailwayCredentials();
  const vercel = useVercelCredentials();
  // Success, not mere settlement: the fetchers turn any request failure into
  // `[]`, so a settled-but-failed query is indistinguishable from "nothing
  // connected". Gating on `isSuccess` keeps a connected provider honest (no
  // phantom "Connect" nudge during an API failure); failed queries fall back
  // to stateless rows and self-heal via retry + focus refetch.
  const ready = [google, github, notion, railway, vercel].every((q) => q.isSuccess);
  const integrations = useMemo(() => {
    // One row set per credential provider. A provider without a hook above is
    // a compile error here, so a new route family cannot resolve as "nothing
    // connected" by omission.
    const rowsByProvider = {
      google: google.data,
      github: github.data,
      notion: notion.data,
      railway: railway.data,
      vercel: vercel.data,
    } satisfies Record<CredentialProvider, ReadonlyArray<CredentialRow> | undefined>;
    return INTEGRATION_PAGES.map((page) => {
      if (!isLiveProviderSlug(page.slug)) return { ...page, connectedAccounts: [] };
      const rows = rowsByProvider[credentialProviderOf(page.slug)] ?? [];
      const spec = INTEGRATIONS[page.slug].credential;
      return resolveOne(
        page,
        rows.filter((row) => credentialSatisfies(spec, row)),
      );
    });
  }, [google.data, github.data, notion.data, railway.data, vercel.data]);
  return useMemo(() => ({ integrations, ready }), [integrations, ready]);
}

export function useResolvedIntegrations(): ReadonlyArray<ResolvedIntegration> {
  return useResolvedIntegrationsWithReady().integrations;
}

export function useResolvedIntegration(slug: string): ResolvedIntegration | undefined {
  const all = useResolvedIntegrations();
  return all.find((p) => p.slug === slug);
}

/** Overlay the rows that prove `page` connected; none leaves the catalog reading in place. */
function resolveOne(
  page: IntegrationPage,
  matching: ReadonlyArray<CredentialRow>,
): ResolvedIntegration {
  if (matching.length === 0) {
    return { ...page, connectedAccounts: [] };
  }
  return {
    ...page,
    status: "connected",
    actionLabel: "Manage",
    connectedAccounts: matching.map((c) => ({
      id: c.id,
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
  /** Google products no active credential scopes. */
  missing: ReadonlyArray<{ slug: GoogleSlug; name: string }>;
}

export function useGoogleScopeGaps(): GoogleScopeGaps {
  const { data: googleCreds } = useGoogleCredentials();
  return useMemo(() => {
    const active = (googleCreds ?? []).filter((c) => c.status === "active");
    if (active.length === 0) {
      return { connected: false, accountLabel: null, missing: [] };
    }
    // Missing iff no active credential satisfies the product's connected rule
    // (one of the entry's `anyOfScopes`): the same predicate the tiles use.
    const missing = GOOGLE_SLUGS.flatMap((slug) => {
      const entry = INTEGRATIONS[slug];
      if (active.some((credential) => credentialSatisfies(entry.credential, credential))) {
        return [];
      }
      return [{ slug, name: entry.displayName }];
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
