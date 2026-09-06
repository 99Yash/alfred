import { readFreshIntegrationAvailability } from "@alfred/assistant/connections";
import { readEventSourceHealth } from "./event-source-health";

/** Load the complete mutable context required for one workflow readiness decision. */
export async function readWorkflowReadinessContext(userId: string) {
  const availability = await readFreshIntegrationAvailability(userId);
  const eventSourceHealth = await readEventSourceHealth(userId, availability);
  return { availability, eventSourceHealth };
}
