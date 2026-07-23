/**
 * Shared integration primitives — the cross-provider building blocks that no
 * single provider module owns: the bearer-credential store and the one
 * authenticated REST transport the general read-only passthrough tier
 * (ADR-0074 rung-a) shares across every REST provider.
 */

export * from "./credentials";
export {
  authedFetch,
  INTEGRATION_FETCH_TIMEOUT_MS,
  type AuthedFetchProfile,
  type AuthedFetchRequest,
} from "./authed-fetch";
export {
  restPassthroughFetch,
  PassthroughUrlError,
  type RestPassthroughProfile,
  type RawRestResponse,
} from "./rest-passthrough";
