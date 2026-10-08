import type { SupportedRestSlug } from "@alfred/contracts";

/** Per-provider policy for the REST read gate. No secrets or base URLs. */
export interface RestProviderGateConfig {
  /** Anchored regexes for POST paths that are reads. Every other POST is denied. */
  readViaPostAllowlist: readonly RegExp[];
  /** GET/HEAD endpoints that side-effect anyway. */
  sideEffectingGetDenylist: readonly RegExp[];
  /** Known 403s under the current auth, rejected up front with a clear reason. */
  authScopeDenylist: readonly { pattern: RegExp; detail: string }[];
}

const NO_READ_VIA_POST: readonly RegExp[] = [];

const NO_SIDE_EFFECTING_GET: readonly RegExp[] = [];

const NO_AUTH_SCOPE_DENIALS: readonly { pattern: RegExp; detail: string }[] = [];

export const REST_GATE_CONFIG = {
  github: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    // `/notifications` is user-scoped, so the App installation token gets a 403.
    authScopeDenylist: [
      {
        pattern: /^\/notifications(?:\/|$)/,
        detail:
          "GitHub /notifications is user-scoped and is not reachable under the App installation token. Repo-scoped reads (workflow runs, commits, releases, issues, pulls) are reachable.",
      },
    ],
  },
  notion: {
    // Notion's search and database query are POST reads.
    readViaPostAllowlist: [/^\/search$/, /^\/databases\/[^/]+\/query$/],
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  vercel: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  sentry: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    // `/organizations/` answers only a user token; an internal-integration token gets a 403.
    authScopeDenylist: [
      {
        pattern: /^\/organizations\/?$/,
        detail:
          "Sentry /organizations/ answers only a user token; an internal-integration token is scoped to one organization. Read under /organizations/{org}/ instead.",
      },
    ],
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
    // `values:batchGetByDataFilter` is a POST read, not yet allowed.
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
  slides: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
    authScopeDenylist: NO_AUTH_SCOPE_DENIALS,
  },
} satisfies Record<SupportedRestSlug, RestProviderGateConfig>;
