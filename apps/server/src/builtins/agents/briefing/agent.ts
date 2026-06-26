import {
  getBossModel,
  meteredGenerateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "@alfred/ai";
import type { IanaTimezone } from "@alfred/contracts";
import { buildSystemPrompt } from "./prompt";
import { buildBriefingTools, type DumpedBriefing } from "./tools";

/**
 * Daily-briefing agent driver.
 *
 * Why not AlfredAgent (from @alfred/ai/agent) yet:
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
  briefingDate: string;
  /** User's IANA timezone — defines local day boundaries for the calendar tool. */
  timezone: IanaTimezone;
  /** Forwarded to the metering wrapper for per-call attribution. */
  runId: string;
  stepId: string;
}

export interface RunBriefingAgentResult {
  briefing: DumpedBriefing;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
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
  });

  const bag = buildBriefingTools({
    userId: args.userId,
    slot: args.slot,
    sinceIngestedAt: args.sinceIngestedAt,
    untilIngestedAt: args.untilIngestedAt,
    briefingDate: args.briefingDate,
    timezone: args.timezone,
  });

  const seed: ModelMessage[] = [
    {
      role: "user",
      content:
        `Compose the ${args.slot} briefing for ${args.recipientFirstName ?? "the user"}. ` +
        `Start by reading list_prior_briefings, then list_emails_since. End with dump_briefing.`,
    },
  ];

  const model = getBossModel();
  const result = await meteredGenerateText(
    {
      model,
      system,
      messages: seed,
      tools: bag.tools,
      // Bound the loop. dump_briefing should be reached well within this
      // budget; if not, we want to surface that as a failure rather than
      // burn tokens indefinitely.
      stopWhen: stepCountIs(MAX_STEPS),
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
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      totalTokens: result.totalUsage.totalTokens,
    },
    modelId: modelIdOf(model),
    steps: result.steps.length,
  };
}

/**
 * Pull the SDK-provided model id off a `LanguageModel` for audit
 * logging. The interface exposes `modelId` as a string; falling back to
 * "unknown" keeps the column non-null without forcing the agent to know
 * which provider it's bound to.
 */
function modelIdOf(model: LanguageModel): string {
  return (model as { modelId?: string }).modelId ?? "unknown";
}

export type { DumpedBriefing } from "./tools";
