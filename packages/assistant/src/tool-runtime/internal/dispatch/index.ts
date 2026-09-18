/**
 * Tool dispatch — the module door.
 *
 * The god file was split behind the one `DispatchStage` contract, which now
 * lives in `./pipeline` together with the four named stages. This file stays the
 * dispatch module's public surface so `tool-runtime/dispatch.ts` and the deep
 * export leaf keep the same names and every existing caller works unchanged.
 *
 * Read `./pipeline` for the entry map: registry resolution, input validation,
 * retry suppression, and staging/approval resume.
 */
export {
  dispatchToolCall,
  registerDispatchToolCallRoundAdapter,
  toolRequiresApproval,
  resolveEffectiveRiskTier,
  toolCallWouldGate,
  undeclaredToolMessage,
  buildDispatchRejectionTraceInput,
  _setDispatchTraceSinksForTests,
  _setIntegrationAvailabilityReaderForTests,
  type DispatchStage,
  type DispatchStageOutcome,
  type ToolCallDispatchResult,
} from "./pipeline";
