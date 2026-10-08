import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import type { RecordedDecision } from "./use-approval-decision";

/**
 * Post one decision, as typed, for every approvals surface. A question's
 * dismissal is a reason-less `reject`, which the route accepts (ADR-0099).
 * The resulting poke removes the card.
 */
export async function decideApproval(stagingId: string, decision: RecordedDecision): Promise<void> {
  const { error } = await client.api.approvals({ stagingId }).decision.post(decision);

  if (error) throw new Error(responseErrorMessage(error.value, error.status, "Approval decision"));
}
