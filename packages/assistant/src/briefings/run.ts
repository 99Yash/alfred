import { randomUUID } from "node:crypto";
import { type BriefingSlot, DAILY_BRIEFING_WORKFLOW_SLUG } from "@alfred/contracts";
import { startRun } from "@alfred/assistant/execution";

interface EnqueueBriefingRunArgs {
  userId: string;
  slot: BriefingSlot;
  briefingDate: string;
  reason: "cron" | "manual" | "forced";
  scheduledFor?: string;
}

/** Create and enqueue a `daily-briefing` run. Used by the tick and `POST /api/me/briefings/run`. */
export async function enqueueBriefingRun(args: EnqueueBriefingRunArgs): Promise<{ runId: string }> {
  const { slot } = args;

  const trigger =
    args.reason === "cron"
      ? ({ kind: "cron", scheduledFor: args.scheduledFor ?? new Date().toISOString() } as const)
      : ({ kind: "manual" } as const);

  const occurrence =
    trigger.kind === "cron"
      ? {
          trigger,
          workflowRevisionId: null,
          occurrence: {
            kind: "cron" as const,
            workflowId: DAILY_BRIEFING_WORKFLOW_SLUG,
            revisionId: null,
            scheduledFor: trigger.scheduledFor,
          },
        }
      : {
          trigger,
          occurrence: {
            kind: "manual" as const,
            // One id per request. The occurrence index also holds terminal runs, so a fixed
            // `date:slot` id would hand every later retry the first failed run, and the worker
            // ignores a terminal run. The route's throttle and the `briefings` row status stop a
            // double click from making two live runs.
            requestId: `${args.briefingDate}:${slot}:${args.reason}:${randomUUID()}`,
          },
        };

  const { runId } = await startRun({
    userId: args.userId,
    workflowSlug: DAILY_BRIEFING_WORKFLOW_SLUG,
    brief: `${slot} briefing for ${args.briefingDate} (${args.reason})`,
    input: {
      slot,
      reason: args.reason,
      briefingDate: args.briefingDate,
    },
    // This queue does its own fan-out, so it stamps the trigger, not `workflows.tick`.
    ...occurrence,
  });

  return { runId };
}
