/** The dispatch module's public names. The logic lives in `./pipeline`. */
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
