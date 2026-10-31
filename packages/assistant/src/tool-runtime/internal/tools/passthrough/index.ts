/** The read-only passthrough tier (ADR-0074): uncurated reads against an integration's real API. */

export { runRestPassthrough } from "./rest-adapter";

export {
  countRunPassthroughCalls,
  passthroughBudgetExhausted,
  PASSTHROUGH_PER_RUN_CEILING,
} from "./budget";

export { passthroughTruncationTelemetry } from "./telemetry";
