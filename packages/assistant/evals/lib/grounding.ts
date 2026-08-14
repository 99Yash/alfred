/**
 * The shape a grounding eval's task returns: the tool the agent chose to call
 * (name + args), or `null`/`text` when it answered without one. Shared by the
 * grounding evals (calendar, github, sender-suppression) so they can't drift.
 */
export interface GroundingTaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}
