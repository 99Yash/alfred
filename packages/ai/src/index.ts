export {
  type ChatModelTier,
  MEDIA_INPUT_MODALITIES,
  type ModelRouteHandle,
  route,
  probeRoute,
  routeEffort,
  getMediaEnrichmentModels,
  googleSearchGroundingTools,
  isQuotaOrBillingError,
  isCapacityError,
  withFallback,
  allRouteLegIdentifiers,
} from "./provider";

export { PROVIDER_IDS, providerIdSchema, identifyLanguageModel } from "./models";

// `googleLeg` stays public: an `apps/server` eval probes one Gemini model through it.
export { googleLeg, type RouteLeg, type RouteReasoning } from "./provider-adapter";

// Named, not `export *`: the transports and the audio sniff are internal.
export { transcribeAudio, transcriptionConfigured } from "./gateway";

export { MAX_TRANSCRIBE_AUDIO_BYTES, type TranscribeAudioResult } from "./transcription";

export {
  isStepCount,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type TypedToolCall,
} from "./tools";

export {
  type Transcript,
  DEFAULT_TURN_STREAM_TIMEOUT,
  AlfredAgent,
  classifyStreamFinish,
} from "./agent";

export {
  effectiveInputWindowTokens,
  requestFitsContextWindow,
  resolveEffectiveInputWindowTokens,
} from "./context-window";

export { APPROXIMATE_CHARS_PER_TOKEN } from "./token-estimate";

export {
  STORED_ATTACHMENT_IMAGE_PART,
  storedAttachmentImagePartSchema,
  type StoredAttachmentImagePart,
  type StoredUserMessage,
  type TranscriptMessage,
  parseStoredTranscript,
  toModelMessages,
  toStoredTranscript,
} from "./transcript";

export {
  flushMeteringWrites,
  metered,
  meteredGenerateText,
  meteredGenerateObject,
  meteredStreamText,
  meteredEmbed,
  type AttributedCall,
  type MeteredGenerateObjectArgs,
  getPrice,
  resolveModelContextWindow,
  resolveContextWindowById,
  assertLegPriced,
  _resetPriceCacheForTests,
  flushLangfuse,
  shutdownLangfuse,
  startToolSpan,
  recordDispatchRejection,
  startRuntimeSpan,
  buildRuntimeSpanPayload,
  buildRuntimeSpanEndPayload,
  type RedactedToolInput,
  type ToolSpanInput,
  type ToolSpanCloser,
  type DispatchRejectionInput,
  type DispatchRejectionOutcome,
  type RuntimeSpanInput,
  type RuntimeSpanEndArgs,
  type RuntimeSpanCloser,
  type RuntimeSpanLevel,
  type RuntimeMetaValue,
  type CallKind,
  type CallRole,
  type CallAttribution,
  type CallUsage,
  type MeteredMeta,
  type MeteredResult,
  type ResultExtractor,
  ATTRIBUTION_KINDS,
  isAttributionKind,
  type AttributionKind,
  boundedNameList,
  classifyLatency,
  RUNTIME_LATENCY_THRESHOLDS,
  type LatencyHealth,
  type RuntimeLatencyKind,
} from "./metering/index";
