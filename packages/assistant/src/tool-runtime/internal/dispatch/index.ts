/** The dispatch module's public names. The logic lives in `./pipeline`. */
export {
  dispatchToolCall,
  registerDispatchToolCallRoundAdapter,
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

export { toolRequiresApproval } from "../../approval-rule";
