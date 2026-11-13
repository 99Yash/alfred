import type { SupportedRestSlug } from "@alfred/contracts";

/** Per-provider policy for the REST read gate. No secrets or base URLs. */
export interface RestProviderGateConfig {
  /** Anchored regexes for POST paths that are reads. Every other POST is denied. */
  readViaPostAllowlist: readonly RegExp[];
  /** GET/HEAD endpoints that side-effect anyway. */
  sideEffectingGetDenylist: readonly RegExp[];
}

const NO_READ_VIA_POST: readonly RegExp[] = [];

const NO_SIDE_EFFECTING_GET: readonly RegExp[] = [];

export const REST_GATE_CONFIG = {
  vercel: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  gmail: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  calendar: {
    // `/freeBusy` is a POST read.
    readViaPostAllowlist: [/^\/freeBusy$/],
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  drive: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  docs: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  sheets: {
    // `values:batchGetByDataFilter` is a POST read, not yet allowed.
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
  slides: {
    readViaPostAllowlist: NO_READ_VIA_POST,
    sideEffectingGetDenylist: NO_SIDE_EFFECTING_GET,
  },
} satisfies Record<SupportedRestSlug, RestProviderGateConfig>;
