import {
  readEventSourceHealth,
  readFreshIntegrationAvailability,
} from "@alfred/assistant/connections";
import type { WorkflowReadinessContext } from "./readiness";

/** Read availability and health as one snapshot, so a trigger's account and its health are the same row. */
export async function readWorkflowReadinessContext(
  userId: string,
): Promise<WorkflowReadinessContext> {
  const availability = await readFreshIntegrationAvailability(userId);
  const eventSourceHealth = await readEventSourceHealth(userId, availability.providers, new Date());

  return { availability, eventSourceHealth };
}
