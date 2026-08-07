// Public seam for the `todos` (tasks) module: todo suggestion + Gmail-sender
// lifecycle resolution. Cross-module callers import these here, not the private
// files. `suggest` owns the source-agnostic `system.suggest_todo` write path
// (ADR-0050); `resolve` owns the dismiss-by-sender/thread reaction that the
// suppression coordinator and the `resolve_todo` tool drive.
export { suggestTodo, type SuggestTodoInput, type SuggestTodoResult } from "./suggest";
export {
  resolveTodosForGmailSender,
  type ResolveTodosForGmailSenderArgs,
  type ResolveTodosForGmailSenderResult,
} from "./resolve";
