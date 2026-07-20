import type { SupportedRestSlug } from "@alfred/contracts";

/**
 * Per-provider REST read-gate configuration — the pure, data-only inputs the
 * read gate ({@link ./gate}) consults to decide reachability. It carries no
 * secrets and no base URLs (authority is pinned in the transport adapter, not
 * chosen by the model); it encodes only the *policy* deltas between providers:
 *
 * - which POST paths are legitimate reads (the exact read-via-POST allowlist),
 * - which GET/HEAD paths are known to side-effect and must be denied anyway,
 * - which paths are known-unreachable under the current auth (pre-flight to a
 *   clearer `auth_scope_unreachable` reason instead of a mysterious 403).
 *
 * Keyed by {@link SupportedRestSlug}, so a new REST-transport supported slug is
 * a compile error until its gate config exists.
 */
export interface RestProviderGateConfig {
  /**
   * Exact namespace-relative POST paths that are legitimate reads (e.g. Notion
   * `/search`, database `query`). Patterns are anchored regexes so
   * parameterized paths (`/databases/{id}/query`) match precisely. Everything
   * not matched here is denied for POST — the allowlist is the whole point.
   */
  readViaPostAllowlist: readonly RegExp[];
  /**
   * Known side-effecting GET/HEAD endpoints on this provider that must be denied
   * even though the method is nominally a read. Empty for providers with no such
   * endpoint; a provider that grows one must add it here before staying supported.
   */
  sideEffectingGetDenylist: readonly RegExp[];
  /**
   * Known-unreachable-under-current-auth endpoints. Pre-flight-rejected with a
   * clear `auth_scope_unreachable` reason + detail rather than left to fail as an
   * opaque upstream 403. This is a *static curated denylist of known cases*, not
   * a predictive gate — every un-enumerated auth failure still comes back as an
   * honest HTTP 403 envelope from the adapter.
   */
  authScopeDenylist: readonly { pattern: RegExp; detail: string }[];
}

const NO_READ_VIA_POST: readonly RegExp[] = [];
const NO_SIDE_EFFECTING_GET: readonly RegExp[] = [];
const NO_AUTH_SCOPE_DENIALS: readonly { pattern: RegExp; detail: string }[] = [];

/**
 * The REST gate config for every supported REST integration. `Record<
 * SupportedRestSlug, …>` forces an entry per provider — the coverage registry
 * and this config can never disagree.
 */
export const REST_GATE_CONFIG: Record<SupportedRestSlug, RestProviderGateConfig> = {
  github: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    // `/notifications` is a *user*-scoped endpoint; under the GitHub App
    // installation token the app acts as the app, not the user, so it 403s.
    // Upgrade the known case to a clear pre-flight reason (probe-verified,
    // PR #504 research). Repo-scoped reads (workflow runs, commits, releases)
    // are reachable and deliberately not listed.
    authScopeDenylist: [
      {
        pattern: /^\/notifications(?:\/|$)/,
        detail:
          "GitHub /notifications is user-scoped and is not reachable under the App installation token. Repo-scoped reads (workflow runs, commits, releases, issues, pulls) are reachable.",
      },
    ],
  },
  notion: {
    // Notion's two canonical reads are POST: full-text search and database query.
    readViaPostAllowlist: [/^\/search$/, /^\/databases\/[^/]+\/query$/],
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  vercel: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  gmail: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  calendar: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  drive: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  docs: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  sheets: {
    // `values:batchGetByDataFilter` is a POST read; add when the Sheets adapter
    // lands and its need is proven. Kept minimal-and-correct for now.
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  slides: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
};
