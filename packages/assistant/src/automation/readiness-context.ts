import {
  readEventSourceHealth,
  readFreshIntegrationAvailability,
} from "@alfred/assistant/connections";
import type { WorkflowReadinessContext } from "./readiness";

/**
 * Load the complete mutable context required for one workflow readiness
 * decision. The health map is read against the same availability snapshot it
 * is returned with, and the resolver takes the pair as one object, so the
 * account a trigger resolves and the account its health was read for are
 * always the same row.
 */
export async function readWorkflowReadinessContext(
  userId: string,
): Promise<WorkflowReadinessContext> {
  const availability = await readFreshIntegrationAvailability(userId);
  const eventSourceHealth = await readEventSourceHealth(userId, availability.providers, new Date());
  return { availability, eventSourceHealth };
}
