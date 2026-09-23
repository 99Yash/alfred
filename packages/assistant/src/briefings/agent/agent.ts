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

/**
 * Daily-briefing agent driver.
 *
 * Why not AlfredAgent (from `@alfred/ai`) yet:
 *   AlfredAgent is the per-turn driver designed for the m13 durable
 *   runtime — `turn()` does one model call, the executor dispatches tool
 *   results and checkpoints between turns. The durable executor for that
 *   loop hasn't landed yet. For this scaffold we use the AI SDK's
 *   built-in tool-loop (generateText + stopWhen + tools-with-execute),
 *   which dispatches in-process and is fine for a single workflow step.
 *   Migration path when m13 lands: swap the body of `runBriefingAgent`
 *   to a turn-loop on AlfredAgent without changing tool definitions or
 *   the prompt.
 */

export interface RunBriefingAgentArgs {
  userId: string;
  slot: "morning" | "evening";
  recipientFirstName: string | null;
  /** Lower bound on `documents.ingested_at` — previous run's watermark, or null for first run. */
  sinceIngestedAt: Date | null;
  /** Upper bound on `documents.ingested_at` — frozen at run start. */
  untilIngestedAt: Date;
  /** YYYY-MM-DD calendar date in the user's timezone — anchors the calendar tool's window. */
  briefingDate: LocalDateKey;
  /** User's IANA timezone — defines local day boundaries for the calendar tool. */
  timezone: IanaTimezone;
  /** Forwarded to the metering wrapper for per-call attribution. */
  runId: string;
  stepId: string;
  /** Positive object-state closure facts from this run's deterministic gather. */
  closedLoops: BriefingClosedLoop[];
  /** One bounded relevance verdict for every still-live loop from the same gather. */
  loopRelevance: BriefingLoopRelevance[];
  /**
   * Open-ask violations the pre-send guard found in an earlier draft of this
   * same run. Present only on a re-prompt; each one is named back to the model
   * verbatim so the rewrite is aimed, not a blind retry (#1082).
   */
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
  /** Number of model turns the loop took. */
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
      // Bound the loop. dump_briefing should be reached well within this
      // budget; if not, we want to surface that as a failure rather than
      // burn tokens indefinitely.
      stopWhen: isStepCount(MAX_STEPS),
    },
    {
      // `briefing` is the cost bucket (ADR-0041), not the call shape — this is
      // an LLM generation, but its spend rolls up apart from per-run LLM cost,
      // matching `composeBriefing`. Langfuse tags split the dimensions back out
      // (`call_kind:llm` + `cost_kind:briefing`), so shape filtering still
      // catches it (#226 review).
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

/**
 * The re-prompt body. Deterministic text built from the guard's findings — the
 * guard itself makes no model call, so this is the workflow spending one extra
 * compose to let the composer fix its own draft before the guard falls back to
 * dropping sentences.
 */
function openAskCorrection(violations: readonly OpenAskViolation[]): string {
  if (violations.length === 0) return "";

  const lines = violations
    .map((violation) => `- ${describeOpenAskViolation(violation)}`)
    .join("\n");

  return (
    `\n\nYour previous draft was rejected. The object-state projection proves each object below is closed, ` +
    `and your draft still framed it as work the user owes:\n${lines}\n` +
    `Rewrite the briefing. Drop each closed object, or mention it only as completed work. ` +
    `Never ask the user to review, approve, merge, or follow up on it.`
  );
}
