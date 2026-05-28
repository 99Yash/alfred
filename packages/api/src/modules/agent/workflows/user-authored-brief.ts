import {
  getBossModel,
  getSubAgentModel,
  resolveModelContextWindow,
  AlfredAgent,
  tool,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "@alfred/ai";
import {
  compactionThresholdTokens,
  parseIntegrationMentions,
  isIntegrationSlug,
  type AgentTranscriptMessage,
  type IntegrationSlug,
  type ToolName,
} from "@alfred/contracts";
import { z } from "zod";
import { compactTranscript } from "../compaction";
import { dispatchToolCall, type DispatchResult } from "../../dispatch";
import { writeScratch } from "../../scratchpad";
import { listToolsForIntegration } from "../../tools/registry";
import { readSubAgentMetadata, subAgentMetadataSchema } from "../sub-agent-metadata";
import type { Step, Workflow } from "../types";

export const USER_AUTHORED_BRIEF_WORKFLOW_SLUG = "__user-authored-brief__";

const TURN_CAP_MAX = 30;

const pendingToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
});
type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

const briefRunStateSchema = z.object({
  activeIntegrations: z.array(z.string().min(1)),
  allowedIntegrations: z.array(z.string()),
  pendingToolCalls: z.array(pendingToolCallSchema),
  subAgent: subAgentMetadataSchema.nullable(),
  inFlightTailStart: z.number().int().min(0),
  turnCount: z.number().int().min(0),
  /**
   * Input tokens reported by the last boss-turn (ADR-0035). `dispatch-tools`
   * adds an estimate of tool-result chars-to-tokens on top to decide
   * whether to route through the compactor before the next turn. Default
   * 0 — the first boss-turn always fits under threshold.
   */
  lastInputTokens: z.number().int().min(0).default(0),
});
type BriefRunState = z.infer<typeof briefRunStateSchema>;

const COMPACT_TRANSCRIPT_STEP_ID = "compact-transcript";
/**
 * Skip the compactor call when the prior transcript is below this byte
 * size — the boss has barely begun and the round-trip would cost more
 * than the deferred compaction. The constant is intentionally inside the
 * workflow rather than `@alfred/contracts`; only this workflow makes the
 * skip decision today.
 */
const COMPACTION_MIN_PRIOR_CHARS = 20_000;
const COMPACTOR_RETRY_ATTEMPTS = 3;

const BOSS_SYSTEM_PROMPT = [
  "You are Alfred, the user's personal assistant agent.",
  "Be concise and practical. Briefly state the next action before calling tools.",
  "Use integration tools for external data and actions. Use system.load_integration when another allowed integration is needed.",
  "Use system.spawn_sub_agent for focused independent investigation. Read sub-agent findings from scratch.<subId>.* and promote verified findings to shared.*.",
  "If a tool result says status is rejected_by_user, do not retry the identical proposal.",
  "End the run with one user-facing summary message and no tool calls.",
].join("\n\n");

const SUB_AGENT_SYSTEM_PROMPT = [
  "You are a focused Alfred sub-agent working from a narrow brief.",
  "Do not spawn other agents. Use tools only when they directly serve the brief.",
  "Write useful findings to scratch.<yourSubId>.summary or a more specific scratch.<yourSubId>.<path> key.",
  "End with a concise summary of what you found and any limits or uncertainty.",
].join("\n\n");

const bossTurnStep: Step<BriefRunState> = {
  id: "boss-turn",
  async run(ctx) {
    if (ctx.state.turnCount >= TURN_CAP_MAX) {
      throw new Error("turn_limit_exceeded");
    }

    const state: BriefRunState = {
      ...ctx.state,
      turnCount: ctx.state.turnCount + 1,
    };
    const transcript = [...ctx.transcript];
    const subAgent = state.subAgent;
    const agent = new AlfredAgent({
      id: subAgent ? subAgent.subId : "boss",
      system: subAgent ? SUB_AGENT_SYSTEM_PROMPT : BOSS_SYSTEM_PROMPT,
      tools: () => resolveSdkTools(state.activeIntegrations, subAgent !== null),
      model: getBossModel(),
      attribution: {
        kind: "llm",
        userId: ctx.userId,
        runId: ctx.runId,
      },
    });

    const result = await agent.turn({
      ctx,
      transcript: transcript as ModelMessage[],
      attribution: {
        stepId: ctx.idempotencyKey,
        attempt: ctx.attempt,
        role: subAgent ? "sub_agent" : "boss",
      },
    });

    const nextTranscript = appendModelMessages(transcript, result.raw.response.messages);
    state.inFlightTailStart = transcript.length;
    state.lastInputTokens = result.usage.inputTokens ?? 0;

    if (result.kind === "final") {
      const output = subAgent
        ? await writeSubAgentSummary({
            parentRunId: subAgent.parentRunId,
            subId: subAgent.subId,
            text: result.text,
          })
        : { text: result.text };
      return {
        kind: "done",
        state,
        transcript: nextTranscript,
        output,
      };
    }

    if (result.kind === "tool-calls") {
      state.pendingToolCalls = result.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      }));
      return {
        kind: "next",
        state,
        transcript: nextTranscript,
        nextStep: "dispatch-tools",
      };
    }

    if (result.reason === "length" || result.reason === "content-filter") {
      return {
        kind: "done",
        state,
        transcript: nextTranscript,
        output: { stoppedReason: result.reason },
      };
    }

    throw new Error(`boss_turn_stopped:${result.reason}`);
  },
};

const dispatchToolsStep: Step<BriefRunState> = {
  id: "dispatch-tools",
  async run(ctx) {
    const state: BriefRunState = {
      ...ctx.state,
      pendingToolCalls: [...ctx.state.pendingToolCalls],
      activeIntegrations: [...ctx.state.activeIntegrations],
    };
    let transcript = [...ctx.transcript];

    while (state.pendingToolCalls.length > 0) {
      const call = state.pendingToolCalls[0]!;
      const result = await dispatchToolCall({
        runId: ctx.runId,
        stepId: "dispatch-tools",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        userId: ctx.userId,
        caller: state.subAgent ? { subId: state.subAgent.subId } : "boss",
        scratchpadRunId: state.subAgent?.parentRunId ?? ctx.runId,
        allowedIntegrations: state.allowedIntegrations,
      });

      if (result.kind === "staged") {
        return {
          kind: "interrupt",
          state,
          transcript,
          wake: result.wake,
        };
      }

      applySystemToolEffect(state, call.toolName, result);
      transcript = [...transcript, toolResultMessage(call, result)];
      state.pendingToolCalls = state.pendingToolCalls.slice(1);
    }

    // ADR-0035: estimate next-turn input size and route through compaction
    // (boss) or fail back to the parent (sub-agent) when over threshold.
    //
    // `lastInputTokens` captures the input billed for the just-completed
    // boss-turn — which read the transcript up to but NOT including the
    // assistant tool-call message it produced. Everything the next
    // boss-turn will see on top of that is the entire suffix starting at
    // `inFlightTailStart` (assistant tool-call message + every tool
    // result we appended above), so size the whole tail, not just the
    // tool results — large tool-call argument blobs or assistant prose
    // would otherwise sneak the estimate under the threshold.
    const isSubAgent = state.subAgent !== null;
    const model = isSubAgent ? getSubAgentModel() : getBossModel();
    const threshold = compactionThresholdTokens(await resolveModelContextWindow(model));
    const tailChars = JSON.stringify(transcript.slice(state.inFlightTailStart)).length;
    const estimated = state.lastInputTokens + Math.ceil(tailChars / 4);

    if (estimated <= threshold) {
      return {
        kind: "next",
        state,
        transcript,
        nextStep: "boss-turn",
      };
    }

    if (isSubAgent) {
      // ADR-0026 / ADR-0035: sub-agents do not compact. Write the
      // structured error into the sub-agent's own scratch zone so the
      // boss can read it via `system.read_scratch` and re-decompose.
      const subAgent = state.subAgent!;
      await writeScratch({
        runId: subAgent.parentRunId,
        zone: "scratch",
        subId: subAgent.subId,
        path: "error",
        value: { reason: "context_pressure_in_subagent", subId: subAgent.subId },
        writtenBy: subAgent.subId,
      });
      throw new Error("context_pressure_in_subagent");
    }

    return {
      kind: "next",
      state,
      transcript,
      nextStep: COMPACT_TRANSCRIPT_STEP_ID,
    };
  },
};

const compactTranscriptStep: Step<BriefRunState> = {
  id: COMPACT_TRANSCRIPT_STEP_ID,
  async run(ctx) {
    const state = ctx.state;
    const transcript = ctx.transcript;

    // Guard 1: nothing to compact — the boss has not yet captured an
    // in-flight tail boundary. Skip silently; the next turn will set it.
    if (state.inFlightTailStart === 0) {
      return { kind: "next", state, nextStep: "boss-turn" };
    }

    const prior = transcript.slice(0, state.inFlightTailStart);
    const inFlightTail = transcript.slice(state.inFlightTailStart);

    // Guard 2: prior transcript is below the round-trip-worth-it floor.
    const priorChars = JSON.stringify(prior).length;
    if (priorChars < COMPACTION_MIN_PRIOR_CHARS) {
      return { kind: "next", state, nextStep: "boss-turn" };
    }

    let result: Awaited<ReturnType<typeof compactTranscript>> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= COMPACTOR_RETRY_ATTEMPTS; attempt++) {
      try {
        result = await compactTranscript({
          prior,
          inFlightTail,
          attribution: {
            userId: ctx.userId,
            runId: ctx.runId,
            stepId: COMPACT_TRANSCRIPT_STEP_ID,
            attempt: ctx.attempt,
            idempotencyKey: `${ctx.idempotencyKey}:compact-${attempt}`,
          },
        });
        break;
      } catch (err) {
        lastError = err;
        if (attempt < COMPACTOR_RETRY_ATTEMPTS) {
          await sleepMs(attempt * 100);
        }
      }
    }
    if (!result) {
      throw new Error(`compactor_failed: ${errorMessage(lastError)}`);
    }

    // Guard 3: post-compaction the in-flight tail itself blows the
    // threshold. There is no further reduction we can make — fail loud
    // rather than risk hallucination from overflow.
    const postChars = JSON.stringify(result.transcript).length;
    const threshold = compactionThresholdTokens(await resolveModelContextWindow(getBossModel()));
    if (Math.ceil(postChars / 4) > threshold) {
      throw new Error("context_overflow_post_compaction");
    }

    // After compaction, the next boss-turn rebuilds its in-flight tail
    // from scratch; the `<run_summary>` system note plus tail is the new
    // baseline.
    const nextState: BriefRunState = { ...state, inFlightTailStart: 0 };
    return {
      kind: "next",
      state: nextState,
      transcript: result.transcript,
      nextStep: "boss-turn",
    };
  },
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

export const userAuthoredBriefWorkflow: Workflow<BriefRunState> = {
  slug: USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
  name: "User-authored brief",
  trigger: { kind: "manual" },
  initialStep: "boss-turn",
  initialState(input) {
    if (!input.brief) throw new Error("user-authored brief workflow requires a brief");
    const allowedIntegrations = readAllowedIntegrations(input.metadata);
    return {
      activeIntegrations: parseIntegrationMentions(input.brief, allowedIntegrations),
      allowedIntegrations: [...allowedIntegrations],
      pendingToolCalls: [],
      subAgent: readSubAgentMetadata(input.metadata),
      inFlightTailStart: 0,
      turnCount: 0,
      lastInputTokens: 0,
    };
  },
  initialTranscript(input) {
    if (!input.brief) throw new Error("user-authored brief workflow requires a brief");
    return [{ role: "user", content: input.brief }];
  },
  steps: {
    "boss-turn": bossTurnStep,
    "dispatch-tools": dispatchToolsStep,
    [COMPACT_TRANSCRIPT_STEP_ID]: compactTranscriptStep,
  },
  stateSchema: briefRunStateSchema,
};

function resolveSdkTools(activeIntegrations: readonly string[], isSubAgent: boolean): ToolSet {
  const out: Partial<Record<ToolName, Tool>> = {};
  const slugs = uniqueIntegrations(["system", ...activeIntegrations]);
  for (const slug of slugs) {
    if (!isIntegrationSlug(slug)) continue;
    for (const registered of listToolsForIntegration(slug)) {
      if (
        isSubAgent &&
        (registered.name === "system.spawn_sub_agent" || registered.name === "system.promote")
      ) {
        continue;
      }
      out[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.inputSchema,
      });
    }
  }
  return out as ToolSet;
}

async function writeSubAgentSummary(args: {
  parentRunId: string;
  subId: string;
  text: string;
}): Promise<{ text: string; scratchKey: string }> {
  const scratchKey = `scratch.${args.subId}.summary`;
  await writeScratch({
    runId: args.parentRunId,
    zone: "scratch",
    subId: args.subId,
    path: "summary",
    value: { text: args.text },
    writtenBy: args.subId,
  });
  return { text: args.text, scratchKey };
}

function applySystemToolEffect(
  state: BriefRunState,
  toolName: string,
  result: DispatchResult,
): void {
  if (toolName !== "system.load_integration" || result.kind !== "executed") return;
  const toolResult = result.toolResult;
  if (!isSuccessfulLoadIntegrationResult(toolResult)) return;
  state.activeIntegrations = uniqueIntegrations([...state.activeIntegrations, toolResult.slug]);
}

function isSuccessfulLoadIntegrationResult(
  value: unknown,
): value is { ok: true; slug: IntegrationSlug } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { slug?: unknown }).slug === "string" &&
    isIntegrationSlug((value as { slug: string }).slug)
  );
}

function toolResultMessage(
  call: PendingToolCall,
  result: Exclude<DispatchResult, { kind: "staged" }>,
): AgentTranscriptMessage {
  const output = dispatchResultToToolOutput(result);
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output,
      },
    ],
  };
}

function dispatchResultToToolOutput(
  result: Exclude<DispatchResult, { kind: "staged" }>,
): { type: "json"; value: unknown } | { type: "error-json"; value: unknown } {
  switch (result.kind) {
    case "executed":
      return {
        type: "json",
        value: toJsonValue({
          status: "executed",
          result: result.toolResult,
          editedByUser: result.editedByUser,
        }),
      };
    case "failed":
      return { type: "error-json", value: toJsonValue({ status: "failed", error: result.error }) };
    case "rejected":
      return { type: "json", value: toJsonValue(result.result) };
    case "invalid_input":
      return { type: "json", value: toJsonValue(result.result) };
    case "unknown_tool":
      return { type: "json", value: toJsonValue(result.result) };
  }
}

function appendModelMessages(
  transcript: AgentTranscriptMessage[],
  messages: ModelMessage[],
): AgentTranscriptMessage[] {
  return [...transcript, ...(messages as AgentTranscriptMessage[])];
}

function uniqueIntegrations(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function readAllowedIntegrations(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.allowedIntegrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { unserializable: String(value) };
  }
}
