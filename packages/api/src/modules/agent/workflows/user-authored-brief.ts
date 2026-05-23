import {
  getBossModel,
  AlfredAgent,
  tool,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "@alfred/ai";
import {
  parseIntegrationMentions,
  isIntegrationSlug,
  type AgentTranscriptMessage,
  type IntegrationSlug,
  type ToolName,
} from "@alfred/contracts";
import { z } from "zod";
import { dispatchToolCall, type DispatchResult } from "../../dispatch";
import { listToolsForIntegration } from "../../tools/registry";
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
  inFlightTailStart: z.number().int().min(0),
  turnCount: z.number().int().min(0),
});
type BriefRunState = z.infer<typeof briefRunStateSchema>;

const BOSS_SYSTEM_PROMPT = [
  "You are Alfred, the user's personal assistant agent.",
  "Be concise and practical. Briefly state the next action before calling tools.",
  "Use integration tools for external data and actions. Use system.load_integration when another allowed integration is needed.",
  "If a tool result says status is rejected_by_user, do not retry the identical proposal.",
  "End the run with one user-facing summary message and no tool calls.",
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
    const agent = new AlfredAgent({
      id: "boss",
      system: BOSS_SYSTEM_PROMPT,
      tools: () => resolveSdkTools(state.activeIntegrations),
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
      },
    });

    const nextTranscript = appendModelMessages(transcript, result.raw.response.messages);
    state.inFlightTailStart = transcript.length;

    if (result.kind === "final") {
      return {
        kind: "done",
        state,
        transcript: nextTranscript,
        output: { text: result.text },
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

    return {
      kind: "next",
      state,
      transcript,
      nextStep: "boss-turn",
    };
  },
};

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
      inFlightTailStart: 0,
      turnCount: 0,
    };
  },
  initialTranscript(input) {
    if (!input.brief) throw new Error("user-authored brief workflow requires a brief");
    return [{ role: "user", content: input.brief }];
  },
  steps: {
    "boss-turn": bossTurnStep,
    "dispatch-tools": dispatchToolsStep,
  },
  stateSchema: briefRunStateSchema,
};

function resolveSdkTools(activeIntegrations: readonly string[]): ToolSet {
  const out: Partial<Record<ToolName, Tool>> = {};
  const slugs = uniqueIntegrations(["system", ...activeIntegrations]);
  for (const slug of slugs) {
    if (!isIntegrationSlug(slug)) continue;
    for (const registered of listToolsForIntegration(slug)) {
      out[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.inputSchema,
      });
    }
  }
  return out as ToolSet;
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
