import {
  rememberSenderSuppression,
  type RememberSenderSuppressionArgs,
  type RememberSenderSuppressionResult,
} from "../knowledge";
import { resolveTodosForGmailSender, type ResolveTodosForGmailSenderResult } from "../todos";

/**
 * Reason stamped on todos dismissed as a reaction to a sender suppression.
 * Relocated here from the knowledge write: dismissing a suppressed sender's
 * todos is a tasks reaction to a knowledge fact, owned by this coordinator.
 */
const SENDER_SUPPRESSION_REASON = "standing_instruction_sender_suppression";

/**
 * The success branch re-adds `resolvedTodos` as a required field so the
 * `system.remember` tool output stays byte-shape-identical to before the
 * knowledge write and the tasks dismissal were decoupled. The failure branch
 * passes the knowledge result through unchanged.
 */
export type RememberAndDismissResult =
  | (Extract<RememberSenderSuppressionResult, { ok: true }> & {
      resolvedTodos: ResolveTodosForGmailSenderResult;
    })
  | Extract<RememberSenderSuppressionResult, { ok: false }>;

/**
 * Compose the knowledge write (`rememberSenderSuppression`) with the tasks
 * reaction (`resolveTodosForGmailSender`). Knowledge no longer reaches into the
 * tasks domain; the `tools` module — which already owns both edges — coordinates
 * them here.
 *
 * On `ok: false` the knowledge result is returned untouched. On any success
 * status (`remembered` **or** `already_exists`) the matching sender's open
 * gmail-sourced todos are dismissed, so `resolvedTodos` is always present on the
 * success branch. The dismissal runs only after the suppression transaction has
 * committed and its Replicache pokes have been emitted, matching the ordering the
 * knowledge write used to perform inline.
 */
export async function rememberSenderSuppressionAndDismissTodos(
  args: RememberSenderSuppressionArgs,
): Promise<RememberAndDismissResult> {
  const result = await rememberSenderSuppression(args);
  if (!result.ok) return result;

  const resolvedTodos = await resolveTodosForGmailSender({
    userId: args.userId,
    senderEmail: result.instruction.target.email,
    accountId: result.instruction.target.accountId,
    reason: SENDER_SUPPRESSION_REASON,
  });

  return { ...result, resolvedTodos };
}
