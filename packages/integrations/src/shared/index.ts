/**
 * Shared integration primitives — the cross-provider building blocks that no
 * single provider module owns: the bearer-credential store and the one
 * authenticated REST transport the general read-only passthrough tier
 * (ADR-0074 rung-a) shares across every REST provider.
 *
 * Transient retry is deliberately absent from this surface: it is an internal
 * composition detail of `defineProviderClient`, whose configured client is the
 * public door. Only `RetryPolicy` crosses, because a bind site states the
 * envelope. A sibling inside this package still imports `./retry` directly.
 */

export * from "./credentials";
export {
  authedFetch,
  INTEGRATION_FETCH_TIMEOUT_MS,
  type AuthedFetchProfile,
  type AuthedFetchRequest,
} from "./authed-fetch";
export { authedJson, type AuthedJsonOptions } from "./authed-json";
export { RETRY_BASE_DELAY_MS, type RetryPolicy } from "./retry";
export { throwUpstreamError } from "./upstream-error";
export {
  defineProviderClient,
  type ProviderClient,
  type ProviderClientConfig,
  type ProviderRequest,
  type ProviderRequestContext,
  type QueryValue,
} from "./provider-client";
export { once, type ProviderBindOptions, type ProviderFactory } from "./provider";
export {
  restPassthroughFetch,
  restPassthroughCapability,
  PassthroughUrlError,
  type RestPassthroughCapability,
  type RestPassthroughProfile,
  type RawRestResponse,
} from "./rest-passthrough";
