import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { toast } from "~/lib/toast";
import type { RecordedDecision } from "./use-approval-decision";

/** What the decision post did. `restaged`: the card stays pending for a second approval. */
export type DecisionOutcome = "recorded" | "restaged";

/**
 * Post one decision, as typed, for every approvals surface. A question's
 * dismissal is a reason-less `reject`, which the route accepts (ADR-0099).
 * A recorded decision's poke removes the card. A restaged one keeps it
 * pending, so this raises the "approve it again" toast for every surface.
 */
export async function decideApproval(
  stagingId: string,
  decision: RecordedDecision,
): Promise<DecisionOutcome> {
  const { data, error } = await client.api.approvals({ stagingId }).decision.post(decision);

  if (error) throw new Error(responseErrorMessage(error.value, error.status, "Approval decision"));

  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
  if (data?.status === "restaged") {
    toast.info({
      message: "Review the refreshed contract",
      description:
        "Alfred updated the derived schedule and account details. Approve it again to activate the workflow.",
    });

    return "restaged";
  }

  return "recorded";
}
