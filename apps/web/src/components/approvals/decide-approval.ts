import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import type { ApprovalDecision, RecordedDecision } from "./use-approval-decision";

/** What the decision route accepts. A question may reject with no reason. */
type WireDecision = ApprovalDecision | { decision: "reject"; expectedRowVersion: number };

/**
 * The wire body for one recorded decision.
 *
 * `dismiss` is a client-only kind. It exists so that a reason-less `reject`
 * stays uncompilable for a write approval, and it becomes the plain `reject`
 * the route already allows for a question (ADR-0099). Every other decision
 * goes as it is.
 */
export function approvalDecisionBody(decision: RecordedDecision): WireDecision {
  return decision.decision === "dismiss"
    ? { decision: "reject", expectedRowVersion: decision.expectedRowVersion }
    : decision;
}

/**
 * Post one approval decision. Shared by the `/approvals` queue and the
 * workflow detail page's Approvals tab, so both surfaces speak to the same
 * route with the same error wording. A successful decision flips the row out
 * of `pending` server-side; the resulting poke removes the card.
 */
export async function decideApproval(stagingId: string, decision: RecordedDecision): Promise<void> {
  const { error } = await client.api
    .approvals({ stagingId })
    .decision.post(approvalDecisionBody(decision));
  if (error) throw new Error(responseErrorMessage(error.value, error.status, "Approval decision"));
}
