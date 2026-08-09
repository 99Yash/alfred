import { readFreshIntegrationAvailability } from "@alfred/assistant/connections";
import { readGmailEventHealth } from "./gmail-event-readiness";

/** Load the complete mutable context required for one workflow readiness decision. */
export async function readWorkflowReadinessContext(userId: string) {
  const availability = await readFreshIntegrationAvailability(userId);
  return {
    availability,
    gmailEventHealth: await readGmailEventHealth(userId, availability),
  };
}
