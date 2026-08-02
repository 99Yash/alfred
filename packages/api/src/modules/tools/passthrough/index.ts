/**
 * General read-only invocation tier (ADR-0074 rung-a, epic #271) — the trusted
 * boundary that lets the boss issue an *uncurated* read against an integration's
 * real API using credentials Alfred already holds.
 *
 * This slice ships the pure, network-free security core: the per-provider gate
 * config, the read gate, the result shaper, and the payload bounds. The
 * per-integration transport adapters, tool registrations, availability/dispatch
 * wiring, and Settings UI land in the subsequent integration slices.
 */

export { REST_GATE_CONFIG } from "./config";
export { assertReadableRestRequest, assertReadableGraphqlRequest } from "./gate";
export { runRailwayPassthrough } from "./railway-adapter";
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
