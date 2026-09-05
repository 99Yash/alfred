import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import type { ApprovalDecision } from "./approval-card";

/**
 * Post one approval decision. Shared by the `/approvals` queue and the
 * workflow detail page's Approvals tab, so both surfaces speak to the same
 * route with the same error wording. A successful decision flips the row out
 * of `pending` server-side; the resulting poke removes the card.
 */
export async function decideApproval(stagingId: string, decision: ApprovalDecision): Promise<void> {
  const { error } = await client.api.approvals({ stagingId }).decision.post(decision);
  if (error) throw new Error(responseErrorMessage(error.value, error.status, "Approval decision"));
}
