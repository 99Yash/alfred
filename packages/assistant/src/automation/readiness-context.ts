import { readFreshIntegrationAvailability } from "@alfred/assistant/connections";
import { readInboundTriggerHealth } from "@alfred/assistant/connections/ingress";
import { readGmailEventHealth } from "./gmail-event-readiness";

/** Load the complete mutable context required for one workflow readiness decision. */
export async function readWorkflowReadinessContext(userId: string) {
  const availability = await readFreshIntegrationAvailability(userId);
  const [gmailEventHealth, inboundTriggerHealth] = await Promise.all([
    readGmailEventHealth(userId, availability),
    readInboundTriggerHealth(userId),
  ]);
  return { availability, gmailEventHealth, inboundTriggerHealth };
}
