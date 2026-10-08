import {
  route,
  identifyLanguageModel,
  meteredGenerateText,
  isStepCount,
  type ModelMessage,
} from "@alfred/ai";
import type { BriefingClosedLoop, BriefingLoopRelevance, IanaTimezone } from "@alfred/contracts";
import type { LocalDateKey } from "@alfred/assistant/time";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { buildSystemPrompt } from "./prompt";
import { buildBriefingTools, type DumpedBriefing } from "./tools";
import { describeOpenAskViolation, type OpenAskViolation } from "../open-ask-guard";

/** Daily-briefing agent. Uses the AI SDK tool loop (`generateText` + `stopWhen`) in one workflow step. */

export interface RunBriefingAgentArgs {
  userId: string;
  slot: "morning" | "evening";
  recipientFirstName: string | null;
  /** Exclusive lower bound on `documents.ingested_at`; null on the first run. */
  sinceIngestedAt: Date | null;
  /** Frozen at run start. */
  untilIngestedAt: Date;
  /** Anchors the calendar tool's window. */
  briefingDate: LocalDateKey;
  /** Local day boundaries for the calendar tool. */
  timezone: IanaTimezone;
  /** For metering attribution. */
  runId: string;
  stepId: string;
  /** Closure facts from this run's gather. */
  closedLoops: BriefingClosedLoop[];
  /** One verdict per live loop, from the same gather. */
  loopRelevance: BriefingLoopRelevance[];
  /** Only on a re-prompt: earlier violations, named back verbatim so the rewrite is aimed (#1082). */
  openAskViolations?: readonly OpenAskViolation[];
}

export interface RunBriefingAgentResult {
  briefing: DumpedBriefing;
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  modelId: string;
  steps: number;
}

const MAX_STEPS = 8;

export async function runBriefingAgent(
  args: RunBriefingAgentArgs,
): Promise<RunBriefingAgentResult> {
  const system = buildSystemPrompt({
    slot: args.slot,
    recipientFirstName: args.recipientFirstName,
    selfIdentity: selfIdentityGrounding(),
  });

  const bag = buildBriefingTools({
    userId: args.userId,
    slot: args.slot,
    sinceIngestedAt: args.sinceIngestedAt,
    untilIngestedAt: args.untilIngestedAt,
    briefingDate: args.briefingDate,
    timezone: args.timezone,
    closedLoops: args.closedLoops,
    loopRelevance: args.loopRelevance,
  });

  const seed: ModelMessage[] = [
    {
      role: "user",
      content:
        `Compose the ${args.slot} briefing for ${args.recipientFirstName ?? "the user"}. ` +
        `Start by reading list_prior_briefings, then list_emails_since, list_closed_loops, and list_loop_relevance. ` +
        `Apply the three honest loop-state tiers, then end with dump_briefing.` +
        openAskCorrection(args.openAskViolations ?? []),
    },
  ];

  const model = route("boss").model();

  const result = await meteredGenerateText(
    {
      model,
      system,
      messages: seed,
      tools: bag.tools,
      // If `dump_briefing` is not reached in this budget, fail rather than burn tokens.
      stopWhen: isStepCount(MAX_STEPS),
    },
    {
      // `briefing` is the cost bucket (ADR-0041), not the call shape. Langfuse tags
      // (`call_kind:llm`, `cost_kind:briefing`) split both back out.
      kind: "briefing",
      role: "briefing",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      name: `agent:daily-briefing:${args.slot}`,
    },
  );

  const briefing = bag.getDumped();

  if (!briefing) {
    throw new Error(
      `[briefing-agent] loop ended without dump_briefing call. ` +
        `finishReason=${result.finishReason} steps=${result.steps.length}`,
    );
  }

  return {
    briefing,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    modelId: identifyLanguageModel(model).modelId,
    steps: result.steps.length,
  };
}

/** The re-prompt text built from the guard's findings. One extra compose before the guard drops sentences. */
function openAskCorrection(violations: readonly OpenAskViolation[]): string {
  if (violations.length === 0) return "";

  const lines = violations
    .map((violation) => `- ${describeOpenAskViolation(violation)}`)
    .join("\n");

  return (
    `\n\nYour previous draft was rejected. The object-state projection proves each object below is closed, ` +
    `and your draft still framed it as work the user owes:\n${lines}\n` +
    `Rewrite the briefing. Keep each closed object only in the past-tense closed-today recap that the loop-state tiers require. ` +
    `Never ask the user to review, approve, merge, or follow up on it.`
  );
}
