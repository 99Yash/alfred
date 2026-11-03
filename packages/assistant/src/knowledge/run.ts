import type { AgentRunTrigger } from "@alfred/db/schemas";
import { randomUUID } from "node:crypto";
import { startRun } from "@alfred/assistant/execution";

/**
 * Create and enqueue a `memory-extraction` run for one user. Used by the daily fan-out, ad-hoc
 * routes, and smoke scripts.
 */
export async function enqueueExtractionForUser(
  userId: string,
  opts?: {
    sinceDays?: number;
    maxDocs?: number;
    /** Skips the LLM call. */
    mode?: "auto" | "manual";
    manualProposals?: Record<
      string,
      Array<{ key: string; value: unknown; confidence: number; rationale: string }>
    >;
    /** Defaults to manual. */
    trigger?: AgentRunTrigger;
    /** Stable id from a retryable caller. */
    requestId?: string;
  },
): Promise<{ runId: string }> {
  const trigger = opts?.trigger ?? { kind: "manual" as const };

  const occurrence =
    trigger.kind === "cron"
      ? {
          trigger,
          workflowRevisionId: null,
          occurrence: {
            kind: "cron" as const,
            workflowId: "memory-extraction",
            revisionId: null,
            scheduledFor: trigger.scheduledFor,
          },
        }
      : trigger.kind === "event"
        ? {
            trigger,
            workflowRevisionId: null,
            occurrence: {
              kind: "event" as const,
              workflowId: "memory-extraction",
              provider: trigger.source ?? "unknown",
              eventId: trigger.eventId,
            },
          }
        : trigger.kind === "manual"
          ? {
              trigger,
              occurrence: {
                kind: "manual" as const,
                requestId: opts?.requestId ?? randomUUID(),
              },
            }
          : { trigger };

  const { runId } = await startRun({
    userId,
    workflowSlug: "memory-extraction",
    brief: "daily fact extraction over recently-ingested documents",
    input: {
      mode: opts?.mode ?? "auto",
      manualProposals: opts?.manualProposals,
      sinceDays: opts?.sinceDays,
      maxDocs: opts?.maxDocs,
    },
    ...occurrence,
  });

  return { runId };
}
