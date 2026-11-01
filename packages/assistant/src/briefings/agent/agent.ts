import { route, meteredGenerateText, isStepCount, type ModelMessage } from "@alfred/ai";
import type {
  BriefingClosedLoop,
  BriefingLoopRelevance,
  DayShape,
  GatherInput,
  GatherProvenance,
  IanaTimezone,
} from "@alfred/contracts";
import {
  BROKEN_CONNECTION_GUIDANCE,
  describeBrokenConnection,
  type BrokenConnection,
} from "@alfred/assistant/connections";
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
  /** The gather's day shape, so `get_day_shape` does not repeat the live GitHub read. */
  dayShape?: DayShape | undefined;
  /**
   * Connections the user must repair. The composer writes one notice per connection; the email
   * renders each notice with its repair link below the body.
   */
  brokenConnections: readonly BrokenConnection[];
  /**
   * How the gather read each input (ADR-0117 decision 1). The composer gets a fact for each input
   * that it reads and that was not `live`. Absent on a run from before provenance.
   */
  provenance?: readonly GatherProvenance[] | undefined;
  /** Only on a re-prompt: earlier violations, named back verbatim so the rewrite is aimed (#1082). */
  openAskViolations?: readonly OpenAskViolation[];
  /** Only on a re-prompt: connection keys the earlier draft wrote no notice for. */
  missingConnectionNotices?: readonly string[];
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

/**
 * Up to eight boss steps at medium reasoning. The value is the 600 s backstop of the metered
 * wrappers, so the deadline does not change. The workflow step has no signal to combine.
 */
const AGENT_TIMEOUT_MS = 600_000;

/**
 * The broken connections as facts (ADR-0100 amendment 2026-10-28, revised). The code supplies
 * what it knows; the composer decides what to tell the user, one notice per connection. The send
 * step adds the repair link and checks that every key has a notice.
 */
function brokenConnectionFacts(connections: readonly BrokenConnection[]): string {
  if (connections.length === 0) return "";

  return (
    `\n\nThese connections need the user to repair them. ` +
    `Write one entry in connectionNotices for each key below, in the briefing's voice.\n\n` +
    `${BROKEN_CONNECTION_GUIDANCE}\n` +
    `The notices render below your body, so do not repeat them in the body. ` +
    `The body must not say that nothing needs attention, or that you saw everything from these sources.\n\n` +
    connections.map(describeBrokenConnection).join("\n")
  );
}

/**
 * The inputs that reach the composer through its tools. Weather and the activity list do not, so
 * their `fallback` and `stale` statements stay in the stored gather and the log.
 */
const COMPOSER_READS = {
  email: "the emails from list_emails_since",
  calendar: "the events from list_calendar_events",
  github_merged: "the merged work in get_day_shape.shipped",
  loop_relevance: "the verdicts from list_loop_relevance",
  weather: null,
  integration_activity: null,
} as const satisfies Record<GatherInput, string | null>;

/**
 * The inputs that the gather could not read (ADR-0117 decision 2). An empty result from such an
 * input is not evidence, so the composer must not turn it into "nothing needs attention".
 * `not_connected` is silent: a source the user does not connect is not a blind input. No input
 * that the composer reads has a `fallback` or a `stale` state today: only weather has a default,
 * and only the activity list has old items. A new one must add its own fact here.
 */
function inputProvenanceFacts(provenance: readonly GatherProvenance[]): string {
  const lines = provenance.flatMap((entry) => {
    const reads = COMPOSER_READS[entry.input];

    if (reads === null || entry.state !== "unavailable" || entry.cause === "not_connected") {
      return [];
    }

    return [`- ${reads}: ${entry.reason}`];
  });

  if (lines.length === 0) return "";

  return (
    `\n\nAlfred could not read these inputs for this briefing. What their tools return is incomplete. ` +
    `Do not say or imply that nothing needs attention, that the day was quiet, or that you saw everything, on the basis of these inputs. ` +
    `Do not write a notice for them unless a connection key above names the same source.\n\n` +
    lines.join("\n")
  );
}

/** Re-prompt text for keys the earlier draft wrote no notice for. */
function connectionNoticeCorrection(missing: readonly string[]): string {
  if (missing.length === 0) return "";

  return (
    `\n\nYour previous draft wrote no connectionNotices entry for these keys: ${missing.join(", ")}. ` +
    `Write one for each key this time.`
  );
}

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
    dayShape: args.dayShape,
  });

  const seed: ModelMessage[] = [
    {
      role: "user",
      content:
        `Compose the ${args.slot} briefing for ${args.recipientFirstName ?? "the user"}. ` +
        `Start by reading list_prior_briefings, then list_emails_since, list_closed_loops, and list_loop_relevance. ` +
        `Apply the three honest loop-state tiers, then end with dump_briefing.` +
        brokenConnectionFacts(args.brokenConnections) +
        inputProvenanceFacts(args.provenance ?? []) +
        openAskCorrection(args.openAskViolations ?? []) +
        connectionNoticeCorrection(args.missingConnectionNotices ?? []),
    },
  ];

  const result = await meteredGenerateText(
    {
      model: route("boss").model(),
      instructions: system,
      messages: seed,
      tools: bag.tools,
      // If `dump_briefing` is not reached in this budget, fail rather than burn tokens.
      stopWhen: isStepCount(MAX_STEPS),
      abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
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
    // The leg that wrote the briefing: the step whose `dump_briefing` tool call actually ran.
    // A trailing wrap-up step starts on the primary again, so `finalStep`
    // would name a leg that did not produce the stored prose.
    modelId: modelIdOfDumpStep(result.steps),
    steps: result.steps.length,
  };
}

/**
 * The serving leg of the step whose `dump_briefing` tool call actually ran. A
 * `tool-result` part exists only when `execute` returned, and a successful
 * `execute` is the only writer of the stored briefing, so the last step with
 * that result is the step that wrote it. `toolCalls` would also match a
 * rejected or throwing call that wrote nothing. The caller already threw when
 * no dump happened, so this is always found.
 */
function modelIdOfDumpStep(
  steps: readonly {
    toolResults: readonly { toolName: string }[];
    response: { modelId: string };
  }[],
): string {
  const step = steps.findLast((s) => s.toolResults.some((r) => r.toolName === "dump_briefing"));

  if (!step) {
    throw new Error(
      `[briefing-agent] loop ended without dump_briefing call. steps=${steps.length}`,
    );
  }

  return step.response.modelId;
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
