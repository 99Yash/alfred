/**
 * Cross-provider building blocks. Retry stays internal: only `RetryPolicy` and its
 * base delay cross, because a bind site states its own envelope.
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

export { hmacSha256Hex, signatureMatches } from "./webhook";

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
