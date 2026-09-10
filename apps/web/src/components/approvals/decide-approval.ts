import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import type { RecordedDecision } from "./use-approval-decision";

/**
 * Post one approval decision. Shared by the `/approvals` queue and the
 * workflow detail page's Approvals tab, so both surfaces speak to the same
 * route with the same error wording. A successful decision flips the row out
 * of `pending` server-side; the resulting poke removes the card.
 *
 * The decision goes on the wire exactly as it is typed. A question's dismissal
 * is already a plain reason-less `reject`, which the route accepts for
 * `ASK_USER_TOOL` (ADR-0099), so no caller has to remember a mapper — and a
 * caller that forgot one used to get a 400.
 */
export async function decideApproval(stagingId: string, decision: RecordedDecision): Promise<void> {
  const { error } = await client.api.approvals({ stagingId }).decision.post(decision);

  if (error) throw new Error(responseErrorMessage(error.value, error.status, "Approval decision"));
}
