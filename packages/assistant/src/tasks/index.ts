// Public seam for todos: `suggest` (`system.suggest_todo`, ADR-0050) and `resolve` (dismiss by sender or thread).
export { suggestTodo, type SuggestTodoInput, type SuggestTodoResult } from "./suggest";

export {
  resolveTodosForGmailSource,
  type ResolveTodosForGmailSourceArgs,
  type ResolveTodosForGmailSourceResult,
} from "./resolve";

export { resolvePaymentTodoFromReceipt, type PaymentReconcilerResult } from "./payment-reconciler";
