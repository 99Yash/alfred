/** The read-only passthrough tier (ADR-0074): uncurated reads against an integration's real API. */

export { REST_GATE_CONFIG } from "./config";

export { assertReadableRestRequest, assertReadableGraphqlRequest } from "./gate";

export { runRestPassthrough } from "./rest-adapter";

export {
  boundPassthroughBody,
  PASSTHROUGH_MAX_ARRAY_ITEMS,
  PASSTHROUGH_MAX_BODY_BYTES,
} from "./bounds";

export {
  passthroughBinaryResult,
  passthroughHttpResult,
  passthroughRejection,
  passthroughTransportError,
} from "./shaper";

export {
  countRunPassthroughCalls,
  passthroughBudgetExhausted,
  PASSTHROUGH_PER_RUN_CEILING,
} from "./budget";

export { passthroughTruncationTelemetry } from "./telemetry";
