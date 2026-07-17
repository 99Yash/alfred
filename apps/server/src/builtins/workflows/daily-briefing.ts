import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  dailyBriefingWorkflowInputSchema,
  runDailyBriefingCompose,
  runDailyBriefingGather,
  runDailyBriefingSend,
  type Workflow,
} from "@alfred/api/backend";
import { z } from "zod";

const stateSchema = z.object({
  slot: z.enum(["morning", "evening"]),
  reason: z.enum(["cron", "manual", "forced"]),
  dryRun: z.boolean().default(false),
  briefingDate: z.string().optional(),
  timezone: z.string().optional(),
  recipientName: z.string().nullable().optional(),
  sinceIngestedAt: z.string().nullable().optional(),
  untilIngestedAt: z.string().optional(),
  briefingId: z.string().optional(),
  quietDay: z.boolean().optional(),
  composed: z
    .object({
      subject: z.string(),
      bodyText: z.string(),
      bodyMarkdown: z.string(),
      citedDocumentIds: z.array(z.string()),
      modelId: z.string(),
    })
    .optional(),
});
type State = z.infer<typeof stateSchema>;

export const dailyBriefingWorkflow: Workflow<State> = {
  slug: DAILY_BRIEFING_WORKFLOW_SLUG,
  name: "Daily briefing (LLM-composed)",
  description:
    "Watermarked LLM-composed daily briefing in two slots (morning, evening). Reads its own prior briefings as memory. Writes the canonical `briefings` table (ADR-0048).",
  trigger: { kind: "cron", schedule: "0 * * * *" },
  initialStep: "gather",
  stateSchema,
  initialState(input) {
    const parsed = dailyBriefingWorkflowInputSchema.parse(input.input ?? {});
    return {
      slot: parsed.slot,
      reason: parsed.reason,
      dryRun: parsed.dryRun,
      briefingDate: parsed.briefingDate,
    };
  },
  steps: {
    gather: { id: "gather", run: runDailyBriefingGather },
    compose: { id: "compose", run: runDailyBriefingCompose },
    send: { id: "send", run: runDailyBriefingSend },
  },
};
