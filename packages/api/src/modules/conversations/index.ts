// Public seam for the `conversations` module. It owns the chat HTTP surface,
// turn admission (`startTurn`), stop behavior (`stopTurn`), and the chat recipe
// (`chatTurnWorkflow`). Execution never imports this module; the recipe is
// registered with execution via `registerRecipe` at boot (ADR-0089).
export { chatRoutes, startTurn, stopTurn } from "./routes";
export { chatTurnWorkflow, CHAT_TURN_WORKFLOW_SLUG } from "./chat-turn";
