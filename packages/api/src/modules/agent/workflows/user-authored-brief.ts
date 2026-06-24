import {
  COMPACTOR_MODEL,
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
  toJsonValue,
  toRecord,
  type AgentTranscriptMessage,
  type IntegrationSlug,
  type ToolName,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { compactTranscript } from "../compaction";
import { estimateTranscriptTokens } from "../compaction/tokens";
import { dispatchToolCall, type DispatchResult } from "../../dispatch";
import { writeScratch } from "../../scratchpad";
import { listToolsForIntegration } from "../../tools/registry";
import { buildConnectedSummary } from "../connected-summary";
import { formatDateGrounding, resolveUserTimezone } from "../grounding";
import {
  readSubAgentMetadata,
  subAgentMetadataSchema,
  SUB_AGENT_WORKFLOW_SLUG,
} from "../sub-agent-metadata";
import type { Step, Workflow } from "../types";

// This workflow is the one sub-agents run on (see SUB_AGENT_WORKFLOW_SLUG);
// keep the slug single-sourced so the two never drift.
export const USER_AUTHORED_BRIEF_WORKFLOW_SLUG = SUB_AGENT_WORKFLOW_SLUG;

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
  // ADR-0053 connected summary, snapshotted once at run start (first boss turn)
  // and reused every turn so the system-prompt prefix stays cache-stable.
  connectedSummary: z.string().optional(),
  // User's IANA timezone, snapshotted once per run so tool-dispatch windows
  // match the date grounding shown to the boss.
  timezone: z.string().optional(),
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
const TRIGGER_EVENT_EXCERPT_CHARS = 4_000;

// Structured after the Anthropic prompt template: role first, operating rules
// in a labelled block, then log-sourced boundary exemplars (the failure modes
// we observed — tool-name invention and date-bouncing; see boss-grounding-gaps
// notes). `buildBossSystemPrompt` appends the date and the ADR-0053 connected
// catalog last, keeping the tool-grounding anchor at the end of the prompt.
const BOSS_SYSTEM_PROMPT_BASE = [
  "You are Alfred, the user's personal assistant agent. Be concise and practical — briefly state the next action before calling tools.",
  [
    "How you work:",
    "- Use integration tools for external data and actions. Integration tools are named integration.action (for example calendar.list_events); never call a bare action name like list_events.",
    "- Use only tools that exist. Never invent a plausible-sounding tool name — pick the closest real tool over guessing, and never ask the user for a parameter (a repo, an account, a date) you can resolve or look up yourself.",
    "- When a needed allowed integration is not active yet, call system.load_integration yourself. Do not ask the user to load an integration just to proceed.",
    '- Resolve relative or partial dates yourself from today\'s date (stated below) — "this week", "in October", "October 2026", "next Tuesday" — and never ask the user to clarify a date you can work out. For a calendar range the relative window fields (today, tomorrow, next_7_days) don\'t cover, call calendar.list_events with explicit RFC3339 timeMin/timeMax bounds.',
    "- Use system.read_user_context before answering questions or making judgments about the user's people, relationships, preferences, standing instructions, projects, or personal context. Do not guess from generic memory when this tool can read Alfred's stored context.",
    "- Use system.spawn_sub_agent for focused independent investigation. Read sub-agent findings from scratch.<subId>.* and promote verified findings to shared.*.",
    "- When the user asks Alfred to track something they need to do, use system.suggest_todo with a concise imperative title and any source ids you know. This creates a rail todo suggestion; it does not execute the task.",
    "- When the user asks to stop surfacing reminders, todos, or briefing items from a sender, use system.remember after resolving a concrete sender email. If the tool asks for clarification, ask the user rather than claiming it is done. When system.remember succeeds, say Alfred will stop surfacing reminders and briefing items from that sender, and that emails will still arrive in Gmail unless the user wants a Gmail filter.",
    "- When the user asks to dismiss or clear existing todos from a Gmail sender/thread, use system.resolve_todo after resolving the sender email or thread id.",
    "- Write actions are gated for user approval. If a tool result says status is rejected_by_user, do not retry the identical proposal.",
  ].join("\n"),
  [
    "Examples of the judgment above:",
    "- Asked about the user's open PRs → call the github tool that actually exists (for example github.search_pull_requests filtered to the user). Do NOT call an invented tool like github.list_pull_requests, and do NOT ask which repo.",
    '- Asked about meetings "in October 2026" → call calendar.list_events with explicit October-2026 bounds; never bounce a resolvable date back to the user.',
  ].join("\n"),
  "End the run with one user-facing summary message and no tool calls.",
].join("\n\n");

function buildBossSystemPrompt(grounding: string, connectedSummary: string): string {
  return `${BOSS_SYSTEM_PROMPT_BASE}\n\nThe current date is ${grounding}.\n\n${connectedSummary}`;
}

const SUB_AGENT_SYSTEM_PROMPT_BASE = [
  "You are a focused Alfred sub-agent working from a narrow brief.",
  [
    "How you work:",
    "- Do not spawn other agents. Use tools only when they directly serve the brief, and only tools that exist — never invent a tool name.",
    "- Write useful findings to scratch.<yourSubId>.summary or a more specific scratch.<yourSubId>.<path> key.",
  ].join("\n"),
  "End with a concise summary of what you found and any limits or uncertainty.",
].join("\n\n");

function buildSubAgentSystemPrompt(grounding: string, connectedSummary: string): string {
  return `${SUB_AGENT_SYSTEM_PROMPT_BASE}\n\nThe current date is ${grounding}.\n\n${connectedSummary}`;
}

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
    if (state.timezone === undefined) {
      state.timezone = await resolveUserTimezone(ctx.userId);
    }
    const grounding = formatDateGrounding(state.timezone);
    if (state.connectedSummary === undefined) {
      state.connectedSummary = await buildConnectedSummary(ctx.userId, state.allowedIntegrations);
    }
    const agent = new AlfredAgent({
      id: subAgent ? subAgent.subId : "boss",
      system: subAgent
        ? buildSubAgentSystemPrompt(grounding, state.connectedSummary)
        : buildBossSystemPrompt(grounding, state.connectedSummary),
      tools: () => resolveSdkTools(state.activeIntegrations, subAgent !== null),
      model: subAgent ? getSubAgentModel() : getBossModel(),
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
        timezone: state.timezone,
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
    const threshold = await resolvePressureThresholdTokens(isSubAgent);
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

    // Guard 2: prior transcript is below the round-trip-worth-it floor
    // and the full transcript is still under the smaller-window threshold.
    // If the in-flight tail itself caused pressure, continue through the
    // compactor so Guard 3 can fail loud if the tail cannot fit.
    const priorChars = JSON.stringify(prior).length;
    const pressureThreshold = await resolvePressureThresholdTokens(false);
    if (
      priorChars < COMPACTION_MIN_PRIOR_CHARS &&
      estimateTranscriptTokens(transcript) <= pressureThreshold
    ) {
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
        if (errorMessage(err) === "compactor_input_too_large") {
          throw err;
        }
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
    const postTokens = estimateTranscriptTokens(result.transcript);
    if (postTokens > pressureThreshold) {
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

async function resolvePressureThresholdTokens(isSubAgent: boolean): Promise<number> {
  const agentWindow = await resolveModelContextWindow(
    isSubAgent ? getSubAgentModel() : getBossModel(),
  );
  if (isSubAgent) return compactionThresholdTokens(agentWindow);
  const compactorWindow = await resolveModelContextWindow(COMPACTOR_MODEL);
  return compactionThresholdTokens(Math.min(agentWindow, compactorWindow));
}

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
    const eventSeed =
      input.trigger.kind === "event" &&
      input.trigger.source &&
      isIntegrationSlug(input.trigger.source)
        ? [input.trigger.source]
        : [];
    return {
      activeIntegrations: uniqueIntegrations([
        ...parseIntegrationMentions(input.brief, allowedIntegrations),
        ...eventSeed.filter((slug) => integrationAllowed(slug, allowedIntegrations)),
      ]),
      allowedIntegrations: [...allowedIntegrations],
      pendingToolCalls: [],
      subAgent: readSubAgentMetadata(input.metadata),
      inFlightTailStart: 0,
      turnCount: 0,
      lastInputTokens: 0,
    };
  },
  async initialTranscript(input) {
    if (!input.brief) throw new Error("user-authored brief workflow requires a brief");
    const transcript: AgentTranscriptMessage[] = [{ role: "user", content: input.brief }];
    const triggerEvent = await buildTriggerEventMessage(input);
    if (triggerEvent) transcript.push(triggerEvent);
    return transcript;
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

function integrationAllowed(slug: string, allowedIntegrations: readonly string[]): boolean {
  return allowedIntegrations.length === 0 || allowedIntegrations.includes(slug);
}

function readAllowedIntegrations(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.allowedIntegrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

async function buildTriggerEventMessage(input: {
  userId: string;
  trigger: { kind: string; source?: string; type?: string; payload?: Record<string, unknown> };
}): Promise<AgentTranscriptMessage | null> {
  const trigger = input.trigger;
  if (trigger.kind !== "event") return null;

  const documentId =
    typeof trigger.payload?.documentId === "string" ? trigger.payload.documentId : undefined;
  const reason = typeof trigger.payload?.reason === "string" ? trigger.payload.reason : undefined;
  if (!documentId) {
    return {
      role: "user",
      content: [
        '<trigger_event unavailable="true">',
        xmlTag("source", trigger.source ?? "unknown"),
        xmlTag("type", trigger.type ?? "unknown"),
        xmlTag("reason", reason ?? "unknown"),
        xmlTag("unavailable_reason", "missing_document_id"),
        "</trigger_event>",
      ].join("\n"),
    };
  }

  const rows = await db()
    .select({
      id: documents.id,
      source: documents.source,
      sourceId: documents.sourceId,
      sourceThreadId: documents.sourceThreadId,
      title: documents.title,
      content: documents.content,
      url: documents.url,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(eq(documents.userId, input.userId), eq(documents.id, documentId)))
    .limit(1);
  const doc = rows[0];

  if (!doc) {
    return {
      role: "user",
      content: [
        '<trigger_event unavailable="true">',
        xmlTag("source", trigger.source ?? "unknown"),
        xmlTag("type", trigger.type ?? "unknown"),
        xmlTag("document_id", documentId),
        xmlTag("reason", reason ?? "unknown"),
        xmlTag("unavailable_reason", "document_not_found"),
        "</trigger_event>",
      ].join("\n"),
    };
  }

  const metadata = toRecord(doc.metadata);
  const excerpt = doc.content.slice(0, TRIGGER_EVENT_EXCERPT_CHARS);
  const truncated = doc.content.length > excerpt.length;
  const metadataSubset = pickTriggerMetadata(metadata);

  return {
    role: "user",
    content: [
      "<trigger_event>",
      xmlTag("source", trigger.source ?? doc.source),
      xmlTag("type", trigger.type ?? "unknown"),
      xmlTag("document_id", doc.id),
      xmlTag("provider_id", doc.sourceId),
      doc.sourceThreadId ? xmlTag("thread_id", doc.sourceThreadId) : "",
      doc.title ? xmlTag("title", doc.title) : "",
      doc.authoredAt ? xmlTag("authored_at", doc.authoredAt.toISOString()) : "",
      doc.url ? xmlTag("url", doc.url) : "",
      reason ? xmlTag("reason", reason) : "",
      xmlTag("truncated", String(truncated)),
      xmlTag("metadata", JSON.stringify(metadataSubset)),
      xmlTag("excerpt", excerpt),
      "</trigger_event>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function pickTriggerMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["from", "to", "cc", "labelIds", "snippet", "historyId", "sizeEstimate"]) {
    if (metadata[key] !== undefined) out[key] = metadata[key];
  }
  return out;
}

function xmlTag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
