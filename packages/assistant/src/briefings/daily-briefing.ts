import { DAILY_BRIEFING_WORKFLOW_SLUG } from "@alfred/contracts";
import type { z } from "zod";
import type { Workflow } from "@alfred/assistant/execution";
import { failBriefingForRun } from "./store";
import { dailyBriefingWorkflowInputSchema } from "./workflow-input";
import {
  dailyBriefingStateSchema,
  runDailyBriefingCompose,
  runDailyBriefingGather,
  runDailyBriefingSend,
  type DailyBriefingOperationState,
} from "./workflow-operations";

type State = DailyBriefingOperationState;

export const dailyBriefingWorkflow: Workflow<
  State,
  string,
  unknown,
  z.output<typeof dailyBriefingWorkflowInputSchema>
> = {
  slug: DAILY_BRIEFING_WORKFLOW_SLUG,
  name: "Daily briefing (LLM-composed)",
  description:
    "Watermarked LLM-composed daily briefing in two slots (morning, evening). Reads its own prior briefings as memory. Writes the canonical `briefings` table (ADR-0048).",
  trigger: { kind: "cron", schedule: "0 * * * *" },
  initialStep: "gather",
  stateSchema: dailyBriefingStateSchema,
  inputSchema: dailyBriefingWorkflowInputSchema,
  // A throw outside a step's `markBriefingFailed`, the lease backstop, and a cancel all end the run
  // here. The row must not stay live, or it blocks every retry for the day (SM-11).
  closure: {
    kind: "client",
    async onTerminal(ctx) {
      await failBriefingForRun({ userId: ctx.userId, runId: ctx.runId });
    },
  },
  initialState({ input: parsed }) {
    return {
      slot: parsed.slot,
      reason: parsed.reason,
      dryRun: parsed.dryRun,
      briefingDate: parsed.briefingDate,
      closedLoops: [],
      loops: [],
    };
  },
  steps: {
    gather: { id: "gather", run: runDailyBriefingGather },
    compose: { id: "compose", run: runDailyBriefingCompose },
    send: { id: "send", run: runDailyBriefingSend },
  },
};
