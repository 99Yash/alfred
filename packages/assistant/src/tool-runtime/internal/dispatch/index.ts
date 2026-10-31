/** The dispatch module's public names. The logic lives in `./pipeline`. */
export {
  dispatchToolCall,
  registerDispatchToolCallRoundAdapter,
  undeclaredToolMessage,
  buildDispatchRejectionTraceInput,
  _setDispatchTraceSinksForTests,
  _setIntegrationAvailabilityReaderForTests,
  type ToolCallDispatchResult,
} from "./pipeline";
