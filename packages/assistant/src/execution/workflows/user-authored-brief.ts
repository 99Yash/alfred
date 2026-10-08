import {
  route,
  resolveEffectiveInputWindowTokens,
  AlfredAgent,
  type ModelMessage,
} from "@alfred/ai";
import {
  compactionThresholdTokens,
  getStringPath,
  isInboundEventSource,
  isNonEmptyString,
  jsonObjectSchema,
  parseIanaTimezone,
  parseIntegrationMentions,
  isIntegrationSlug,
  isToolName,
  workflowRevisionDefinitionSchema,
  workflowRequiredCapabilitySchema,
  type AgentTranscriptMessage,
  type InboundEventSource,
  type JsonObject,
  type JsonValue,
  type ToolRunContext,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { executeToolCallRound, toolNamesForIntegrations } from "@alfred/assistant/tool-runtime";
import { compactTranscript, compactWithRetry } from "../run-compaction";
import {
  estimateNextTurnInputTokens,
  estimateTranscriptTokens,
  shouldSkipCompaction,
} from "../run-compaction/tokens";
import { appendModelResponseMessages } from "../transcript-dedup";
import { publishEvent } from "@alfred/assistant/triggers";
import {
  NESTED_SEGMENT_INDEX,
  shouldPublishToolStarted,
  subAgentToolCardTarget,
  toolCardStarted,
  toolCardTerminal,
} from "./tool-card-events";
import { toolEventOutcome } from "./tool-event-outcome";
import { writeScratch } from "../scratchpad/index";
import { readIntegrationAvailability, readReceiptDocument } from "@alfred/assistant/connections";
import { buildConnectedSummaryFromAvailability } from "../connected-summary";
import { formatDateGrounding } from "../grounding";
import { composeAgentInstructions } from "@alfred/ai/voice";
import { resolveTimezone, selfIdentityGrounding } from "@alfred/assistant/settings";
import {
  foldToolSurfaceState,
  systemToolKernel,
  toolRuntimeForRun,
  toolSurfaceStateFields,
} from "../tool-surface";
import {
  readSubAgentMetadata,
  subAgentMetadataSchema,
  SUB_AGENT_WORKFLOW_SLUG,
} from "../sub-agent-metadata";
import { isTerminalStatus } from "@alfred/contracts";
import type { Step, Workflow, WorkflowInput } from "../registry";
import { getRun } from "../service";
import { pendingToolCallSchema } from "./pending-tool-call";
import { BRIEF_TURN_CAP_MAX, openBriefTurnRetries } from "./turn-budgets";
import { checkWorkflowReadiness } from "./readiness-port";

// Sub-agents run on this workflow, so the slugs are one value.
export const USER_AUTHORED_BRIEF_WORKFLOW_SLUG = SUB_AGENT_WORKFLOW_SLUG;

type BriefToolRunIdentity =
  | {
      caller: "boss";
      runContext: ToolRunContext & { caller: "boss" };
    }
  | {
      caller: { subId: string };
      runContext: ToolRunContext & { caller: "sub_agent" };
    };

function briefToolRunIdentity(
  subAgent: { subId: string } | null | undefined,
): BriefToolRunIdentity {
  return subAgent
    ? {
        caller: { subId: subAgent.subId },
        runContext: { caller: "sub_agent", interaction: "background" },
      }
    : {
        caller: "boss",
        runContext: { caller: "boss", interaction: "background" },
      };
}

const briefRunStateSchema = z
  .object({
    ...toolSurfaceStateFields,
    // Snapshotted on the first turn so the prompt prefix stays cache-stable (ADR-0053).
    connectedSummary: z.string().optional(),
    selfIdentity: z.string().optional(),
    // Snapshotted so tool windows match the date grounding the boss saw.
    timezone: z.string().optional(),
    // Undefined only on legacy sub-agent runs.
    allowedTools: z.array(z.string()).optional(),
    requiredCapabilities: z.array(workflowRequiredCapabilitySchema).optional(),
    pendingToolCalls: z.array(pendingToolCallSchema),
    subAgent: subAgentMetadataSchema.nullable(),
    inFlightTailStart: z.number().int().min(0),
    turnCount: z.number().int().min(0),
    /**
     * Billed input of the last boss turn; `dispatch-tools` adds the new tail to decide on
     * compaction (ADR-0035).
     */
    lastInputTokens: z.number().int().min(0).default(0),
    // Consecutive empties only; a productive turn resets it.
    emptyRetries: z.number().int().min(0).default(0),
    readinessDeferrals: z.number().int().min(0).default(0),
  })
  .transform((state) => foldToolSurfaceState(state));

type BriefRunState = z.infer<typeof briefRunStateSchema>;

const COMPACT_TRANSCRIPT_STEP_ID = "compact-transcript";

const CHECK_READINESS_STEP_ID = "check-readiness";

const READINESS_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** Below this many chars of prior transcript, a compactor call costs more than it saves. */
const COMPACTION_MIN_PRIOR_CHARS = 20_000;

const TRIGGER_EVENT_EXCERPT_CHARS = 4_000;

// `buildBossSystemPrompt` appends the date and connected catalog last, so tool grounding stays at
// the end.
const BOSS_SYSTEM_PROMPT_BASE = [
  "You are Alfred, the user's personal assistant agent. Be concise and practical — briefly state the next action before calling tools.",
  [
    "How you work:",
    "- Use integration tools for external data and actions. Integration tools are named integration.action (for example calendar.list_events); never call a bare action name like list_events.",
    "- Use only tools that exist. Never invent a plausible-sounding tool name — pick the closest real tool over guessing, and never ask the user for a parameter (a repo, an account, a date) you can resolve or look up yourself.",
    "- If the needed exact tool is not visible, call system.search_tools for the capability; its best registered hit is already loaded, so issue the real call on the next turn. Use system.load_tool only for a different exact name, including mcp.call. Do not ask the user to load a tool.",
    '- Resolve relative or partial dates yourself from today\'s date (stated below) — "this week", "in October", "October 2026", "next Tuesday" — and never ask the user to clarify a date you can work out. For a calendar range the relative window fields (today, tomorrow, next_7_days) don\'t cover, call calendar.list_events with explicit RFC3339 timeMin/timeMax bounds.',
    "- Use system.read_user_context before answering questions or making judgments about the user's people, relationships, preferences, standing instructions, projects, or personal context. Do not guess from generic memory when this tool can read Alfred's stored context.",
    "- Use system.spawn_sub_agent for focused independent investigation, then call system.await_sub_agent with its childRunId to get the real result before you continue; read sub-agent findings from scratch.<subId>.* and promote verified findings to shared.*. Never promise an out-of-turn notification when a sub-agent finishes — await it and use the result, or report honestly that it could not complete.",
    "- When the user asks Alfred to track something they need to do, use system.suggest_todo with a concise imperative title and any source ids you know. This creates a rail todo suggestion; it does not execute the task.",
    "- When the user asks to stop surfacing reminders, todos, or briefing items from a sender, use system.remember after resolving a concrete sender email. If the tool asks for clarification, ask the user rather than claiming it is done. When system.remember succeeds, say Alfred will stop surfacing reminders and briefing items from that sender, and that emails will still arrive in Gmail unless the user wants a Gmail filter.",
    "- When the user asks to dismiss or clear existing todos from a Gmail sender/thread, use system.resolve_todo after resolving the sender email or thread id.",
    "- Write actions are gated for user approval. If a tool result says status is rejected_by_user, do not retry the identical proposal.",
    "- Attempt the closest real capability before declaring you can't, and never silently narrow the request — if a tool can't return part of what was asked (for example diff/line counts from a search), get it the right way (github.search to find the PRs, then ONE github.get_pull_requests call over the hits for the totals) or state plainly what you can and can't provide.",
    "- A live Google Sheet, Doc, or shareable link that already answers the request is a finished deliverable — stop there. Do not chase a downloadable PDF/PowerPoint/Excel export; reading a Google file in is text-only, and producing a downloadable binary is a capability you do not have.",
  ].join("\n"),
  [
    "Examples of the judgment above:",
    "- Asked about the user's open PRs → call github.search with type:'pr', state:'open' filtered to the user. Do NOT call an invented tool like github.list_pull_requests, and do NOT ask which repo. For total lines changed, pass every hit to github.get_pull_requests in one call and read its totals.",
    '- Asked about meetings "in October 2026" → call calendar.list_events with explicit October-2026 bounds; never bounce a resolvable date back to the user.',
  ].join("\n"),
  "End the run with one user-facing summary message and no tool calls.",
].join("\n\n");

function buildBossSystemPrompt(
  grounding: string,
  connectedSummary: string,
  selfIdentity: string,
): string {
  return composeAgentInstructions({
    purpose: "assistant_response",
    role: BOSS_SYSTEM_PROMPT_BASE,
    grounding: [`The current date is ${grounding}.`, selfIdentity, connectedSummary],
  });
}

function buildSubAgentSystemPromptBase(subId: string): string {
  return [
    "You are Alfred's investigation specialist, working a focused brief to a real conclusion. You exist because this question needs more than a single lookup — a one-and-done answer is a failed investigation, whatever the subject is.",
    [
      "How you investigate:",
      "- Start from what the brief already gives you — names, ids, links, and any context handed down — and treat every assumption it carries (a role, a label, a category, a cause) as a claim to verify, not a fact. If what you find contradicts it, correct it.",
      "- Work the problem from several distinct angles before you conclude. One angle coming back thin or empty is a signal to try a different angle or a different source — never a reason to stop. What another angle means depends on the subject: different search terms, a connected service you haven't queried yet, the primary source behind a notification, an entity's own page, a related person, PR, thread, or document.",
      "- Keep every angle relevant to the brief. Depth is not tool spam: don't call GitHub for a person background brief, don't search the public web for a private PR you can read directly, and don't use an unrelated source just to make the investigation look broader.",
      "- When a result points at something richer — a link, a profile, a PR, a doc, a task, a thread — go into it (read the page, open the record) instead of stopping at the snippet or the summary.",
      "- Corroborate: a claim you can confirm from two independent sources is worth more than one you can't.",
      "- Do not spawn other agents. Use only tools that exist — never invent a tool name — and reach for the tool that directly advances the investigation.",
      // `parseScratchToolKey` rejects a literal or guessed id, so give the real one.
      `- Your sub-agent id is "${subId}". When you write findings, write them to scratch.${subId}.summary or a more specific scratch.${subId}.<path> key — always use "${subId}" as the sub-agent id in the key; never write a literal "<subId>" or any other value.`,
    ].join("\n"),
    "Know when to stop: once distinct angles stop yielding new signal, conclude. End with a concise summary of what you found, how confident you are, what you corrected or ruled out, and the one identifier, source, or access that would unlock more — never padding a thin result to sound fuller than it is.",
  ].join("\n\n");
}

export function buildSubAgentSystemPrompt(
  grounding: string,
  connectedSummary: string,
  selfIdentity: string,
  subId: string,
): string {
  return composeAgentInstructions({
    purpose: "source_faithful",
    role: buildSubAgentSystemPromptBase(subId),
    grounding: [`The current date is ${grounding}.`, selfIdentity, connectedSummary],
  });
}

const bossTurnStep: Step<BriefRunState> = {
  id: "boss-turn",
  // One non-streaming model call can run minutes. A reclaim would pay for it twice.
  staleAfterMs: 6 * 60_000,
  async run(ctx) {
    if (ctx.state.turnCount >= BRIEF_TURN_CAP_MAX) {
      throw new Error("turn_limit_exceeded");
    }

    const state: BriefRunState = {
      ...ctx.state,
      turnCount: ctx.state.turnCount + 1,
    };

    const transcript = [...ctx.transcript];
    const subAgent = state.subAgent;

    if (state.timezone === undefined) {
      state.timezone = await resolveTimezone(ctx.userId);
    }

    const grounding = formatDateGrounding(parseIanaTimezone(state.timezone));
    // A chat-spawned child reports through its parent. Its chat address does not let it read or
    // change the chat.
    const toolRunContext = briefToolRunIdentity(subAgent).runContext;
    const availability = await readIntegrationAvailability(ctx.userId);

    const tools = toolRuntimeForRun({
      userId: ctx.userId,
      runId: ctx.runId,
      workflow: USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
      spanCaller: subAgent ? `sub:${subAgent.subId}` : "boss",
      context: toolRunContext,
      allowedIntegrations: state.allowedIntegrations,
      availability,
    });

    if (state.connectedSummary === undefined) {
      state.connectedSummary = buildConnectedSummaryFromAvailability(
        availability,
        state.allowedIntegrations,
        tools.context,
      );
    }

    if (state.selfIdentity === undefined) {
      state.selfIdentity = selfIdentityGrounding();
    }

    await tools.preload(state, transcript);

    const agent = new AlfredAgent({
      id: subAgent ? subAgent.subId : "boss",
      system: subAgent
        ? buildSubAgentSystemPrompt(
            grounding,
            state.connectedSummary,
            state.selfIdentity,
            subAgent.subId,
          )
        : buildBossSystemPrompt(grounding, state.connectedSummary, state.selfIdentity),
      tools: () => tools.forModel(state.activeTools),
      model: subAgent ? route("subAgent").model() : route("boss").model(),
      attribution: {
        kind: "llm",
        userId: ctx.userId,
        runId: ctx.runId,
      },
    });

    const retries = openBriefTurnRetries(transcript);

    const result = await agent.turn({
      ctx,
      // SAFETY: AgentTranscriptMessage is the persisted view of ModelMessage.
      transcript: transcript as ModelMessage[],
      attribution: {
        stepId: ctx.idempotencyKey,
        attempt: ctx.attempt,
        role: subAgent ? "sub_agent" : "boss",
      },
    });

    // On invalid tool input the SDK adds its own tool result. `dispatch-tools` writes the real one,
    // and two results for one call make Anthropic return a 400.
    const stepCallIds = new Set(
      result.kind === "tool-calls" ? result.toolCalls.map((call) => call.toolCallId) : [],
    );

    const nextTranscript = appendModelResponseMessages(
      transcript,
      // SAFETY: AgentTranscriptMessage is the persisted view of the SDK messages.
      result.raw.responseMessages as AgentTranscriptMessage[],
      stepCallIds,
    );

    state.inFlightTailStart = transcript.length;
    state.lastInputTokens = result.usage.inputTokens ?? 0;

    if (result.kind === "empty") {
      // The call succeeded with an empty stream, so `withFallback` cannot catch it.
      const retry = retries.afterEmptyCompletion(state);

      if (retry) {
        console.warn(
          `[boss-turn] empty completion (finishReason:${result.finishReason}); retry ` +
            `${retry.attempt}/${retry.max} (run ${ctx.runId})`,
        );

        return retry.step;
      }

      throw new Error("boss_turn_empty_completion");
    }

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
        state: { ...state, emptyRetries: 0 },
        transcript: nextTranscript,
        output,
        summary: result.text,
      };
    }

    if (result.kind === "tool-calls") {
      state.emptyRetries = 0;
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
        summary: `Stopped: ${result.reason}`,
      };
    }

    throw new Error(`boss_turn_stopped:${result.reason}`);
  },
};

/**
 * False when the parent run is terminal or missing; then a sub-agent card would arm a barrier
 * nothing releases.
 */
export async function parentRunStillOpen(parentRunId: string, userId: string): Promise<boolean> {
  const status = (await getRun(parentRunId, userId))?.status;

  return status !== undefined && !isTerminalStatus(status);
}

const dispatchToolsStep: Step<BriefRunState> = {
  id: "dispatch-tools",
  async run(ctx) {
    const state: BriefRunState = {
      ...ctx.state,
      pendingToolCalls: [...ctx.state.pendingToolCalls],
      activeTools: [...ctx.state.activeTools],
    };

    let transcript = [...ctx.transcript];

    const runIdentity = briefToolRunIdentity(state.subAgent);

    // Stream this child's tool calls into the parent's chat turn (ADR-0073); null means no card.
    const chatTarget = await subAgentToolCardTarget(
      state.subAgent,
      ctx.runId,
      ctx.userId,
      parentRunStillOpen,
    );

    const round = await executeToolCallRound({
      calls: state.pendingToolCalls,
      transcript,
      activeNames: state.activeTools,
      run: {
        runId: ctx.runId,
        stepId: "dispatch-tools",
        userId: ctx.userId,
        workflow: USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
        fence: ctx.fence,
        ...runIdentity,
        scratchpadRunId: state.subAgent?.parentRunId ?? ctx.runId,
        timezone: state.timezone ? parseIanaTimezone(state.timezone) : undefined,
        allowedIntegrations: state.allowedIntegrations,
        allowedTools: state.allowedTools?.filter(isToolName),
        requiredCapabilities: state.requiredCapabilities,
      },
      onCallStarted: async (call, activeNames) => {
        if (chatTarget && shouldPublishToolStarted(activeNames, call.toolName)) {
          await publishEvent({
            untransacted: true,
            userId: ctx.userId,
            kind: "chat.tool",
            payload: toolCardStarted(chatTarget, call, NESTED_SEGMENT_INDEX),
          });
        }
      },
    });

    state.activeTools = round.activeNames;

    if (round.kind === "waiting") {
      return { kind: "interrupt", state, transcript, wake: round.wake };
    }

    for (const completion of round.calls) {
      if (!chatTarget) continue;
      await publishEvent({
        untransacted: true,
        userId: ctx.userId,
        kind: "chat.tool",
        payload: toolCardTerminal(chatTarget, completion.call, toolEventOutcome(completion), {
          segmentIndex: NESTED_SEGMENT_INDEX,
        }),
      });
    }

    transcript = round.transcript;
    state.pendingToolCalls = [];

    // Over the threshold, the boss compacts and a sub-agent fails back to its parent (ADR-0035).
    // Size the whole tail from `inFlightTailStart`, tool-call arguments included, not just the
    // results.
    const isSubAgent = state.subAgent !== null;
    const threshold = await resolvePressureThresholdTokens(isSubAgent);

    const estimated = estimateNextTurnInputTokens({
      priorInputTokens: state.lastInputTokens,
      inFlightTail: transcript.slice(state.inFlightTailStart),
    });

    if (estimated <= threshold) {
      return {
        kind: "next",
        state,
        transcript,
        nextStep: "boss-turn",
      };
    }

    if (isSubAgent) {
      // Sub-agents do not compact; the error goes to scratch so the boss can split the work again.
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

    // No tail boundary yet; the next turn sets it.
    if (state.inFlightTailStart === 0) {
      return { kind: "next", state, nextStep: "boss-turn" };
    }

    const prior = transcript.slice(0, state.inFlightTailStart);
    const inFlightTail = transcript.slice(state.inFlightTailStart);

    // Skip a small prior, unless the tail itself causes the pressure.
    const priorChars = JSON.stringify(prior).length;
    const pressureThreshold = await resolvePressureThresholdTokens(false);

    const nextTurnInputTokens = estimateNextTurnInputTokens({
      priorInputTokens: state.lastInputTokens,
      inFlightTail,
    });

    if (
      shouldSkipCompaction({
        priorChars,
        minimumPriorChars: COMPACTION_MIN_PRIOR_CHARS,
        nextTurnInputTokens,
        pressureThresholdTokens: pressureThreshold,
      })
    ) {
      return { kind: "next", state, nextStep: "boss-turn" };
    }

    const result = await compactWithRetry(
      (attempt) =>
        compactTranscript({
          prior,
          inFlightTail,
          attribution: {
            userId: ctx.userId,
            runId: ctx.runId,
            stepId: COMPACT_TRANSCRIPT_STEP_ID,
            attempt: ctx.attempt,
            idempotencyKey: `${ctx.idempotencyKey}:compact-${attempt}`,
          },
        }),
      // Background: no user can stop it, and a backoff is affordable.
      { abortSignal: "none", delayBeforeRetryMs: (attempt) => attempt * 100 },
    );

    // The tail alone is over the threshold and cannot shrink further, so fail.
    const postTokens = estimateTranscriptTokens(result.transcript);

    if (postTokens > pressureThreshold) {
      throw new Error("context_overflow_post_compaction");
    }

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
  const agentModel = isSubAgent ? route("subAgent").model() : route("boss").model();

  const effectiveWindow = await resolveEffectiveInputWindowTokens({
    models: isSubAgent ? [agentModel] : [agentModel, route("compactor").model()],
  });

  return compactionThresholdTokens(effectiveWindow);
}

export const userAuthoredBriefWorkflow: Workflow<BriefRunState> = {
  slug: USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
  name: "User-authored brief",
  trigger: { kind: "manual" },
  initialStep: CHECK_READINESS_STEP_ID,
  closure: { kind: "none" },
  initialState(input) {
    if (!input.brief) throw new Error("user-authored brief workflow requires a brief");
    const authoredMetadata = readBriefAuthoredMetadata(input.metadata);
    const allowedIntegrations = authoredMetadata.allowedIntegrations ?? [];
    const allowedTools = authoredMetadata.allowedTools;
    const requiredCapabilities = authoredMetadata.requiredCapabilities;

    const eventSeed =
      input.trigger.kind === "event" &&
      input.trigger.source &&
      isIntegrationSlug(input.trigger.source)
        ? [input.trigger.source]
        : [];

    const seededIntegrations = uniqueIntegrations([
      ...parseIntegrationMentions(input.brief, allowedIntegrations),
      ...eventSeed.filter((slug) => integrationAllowed(slug, allowedIntegrations)),
    ]);

    const preloadedTools = allowedTools ?? toolNamesForIntegrations(seededIntegrations);

    return {
      activeTools: allowedTools ?? [...systemToolKernel(), ...preloadedTools],
      preloadedTools,
      preloadApplied: allowedTools !== undefined,
      allowedIntegrations: [...allowedIntegrations],
      ...(allowedTools ? { allowedTools } : {}),
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
      pendingToolCalls: [],
      subAgent: readSubAgentMetadata(input.metadata),
      inFlightTailStart: 0,
      turnCount: 0,
      lastInputTokens: 0,
      emptyRetries: 0,
      readinessDeferrals: 0,
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
    [CHECK_READINESS_STEP_ID]: {
      id: CHECK_READINESS_STEP_ID,
      async run(ctx) {
        const verdict = await checkWorkflowReadiness({ runId: ctx.runId, userId: ctx.userId });

        if (verdict.kind === "ready") {
          return {
            kind: "next",
            state: { ...ctx.state, readinessDeferrals: 0 },
            nextStep: "boss-turn",
          };
        }

        if (verdict.kind === "blocked") {
          return { kind: "blocked", state: ctx.state, output: { readiness: verdict.problems } };
        }

        const delay = READINESS_RETRY_DELAYS_MS[ctx.state.readinessDeferrals];

        if (delay === undefined) {
          throw new Error("Workflow readiness stayed unavailable after the bounded retry policy");
        }

        return {
          kind: "defer",
          state: { ...ctx.state, readinessDeferrals: ctx.state.readinessDeferrals + 1 },
          retryAt: new Date(Date.now() + delay),
          output: { reason: verdict.reason },
          reason: "provider_unhealthy",
        };
      },
    },
    "boss-turn": bossTurnStep,
    "dispatch-tools": dispatchToolsStep,
    [COMPACT_TRANSCRIPT_STEP_ID]: compactTranscriptStep,
  },
  stateSchema: briefRunStateSchema,
  // One child per (parentRunId, parentToolCallId) (#375). The spawn runs in the step body, not
  // through `stageAction`, so a double-run step could otherwise spawn two paid children.
  dedupKey(input) {
    const sub = readSubAgentMetadata(input.metadata);

    return sub ? `sub:${sub.parentRunId}:${sub.parentToolCallId}` : null;
  },
};

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

function uniqueIntegrations(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function integrationAllowed(slug: string, allowedIntegrations: readonly string[]): boolean {
  return allowedIntegrations.length === 0 || allowedIntegrations.includes(slug);
}

/**
 * Derived from the revision contract, so a new authoring constraint also binds execution.
 * Optional: sub-agent runs carry only `allowedIntegrations`, and legacy runs carry none.
 */
const briefAuthoredMetadataSchema = workflowRevisionDefinitionSchema
  .pick({
    allowedIntegrations: true,
    allowedTools: true,
    requiredCapabilities: true,
  })
  .partial();

type BriefAuthoredMetadata = z.infer<typeof briefAuthoredMetadataSchema>;

function readBriefAuthoredMetadata(metadata: unknown): BriefAuthoredMetadata {
  return briefAuthoredMetadataSchema.parse(metadata ?? {});
}

async function buildTriggerEventMessage(
  input: WorkflowInput,
): Promise<AgentTranscriptMessage | null> {
  const trigger = input.trigger;

  if (trigger.kind !== "event") return null;

  const parsedPayload = jsonObjectSchema.safeParse(trigger.payload ?? {});
  const payload = parsedPayload.success ? parsedPayload.data : {};

  const documentIdValue = payload["documentId"];
  const documentId = isNonEmptyString(documentIdValue) ? documentIdValue : undefined;

  const receiptIdValue = payload["receiptId"];
  const receiptId = isNonEmptyString(receiptIdValue) ? receiptIdValue : undefined;

  const reasonValue = payload["reason"];
  const reason = isNonEmptyString(reasonValue) ? reasonValue : undefined;

  if (!documentId && receiptId && trigger.source && isInboundEventSource(trigger.source)) {
    return buildReceiptTriggerMessage({
      userId: input.userId,
      source: trigger.source,
      type: trigger.type,
      rawKind: trigger.rawKind,
      receiptId,
    });
  }

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

  const parsedMetadata = jsonObjectSchema.safeParse(doc.metadata);
  const metadataSubset = pickTriggerMetadata(parsedMetadata.success ? parsedMetadata.data : {});

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
      xmlTag("metadata", JSON.stringify(metadataSubset)),
      ...triggerEventExcerptTags(doc.content),
      "</trigger_event>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * The `<trigger_event>` for an inbound receipt (ADR-0097). It reads the receipt's document,
 * not the raw payload, and bounds the body. `documents.raw` never reaches the model.
 */
async function buildReceiptTriggerMessage(input: {
  userId: string;
  source: InboundEventSource;
  type: string | undefined;
  rawKind: string | undefined;
  receiptId: string;
}): Promise<AgentTranscriptMessage> {
  const doc = await readReceiptDocument({
    id: input.receiptId,
    userId: input.userId,
    provider: input.source,
  });

  const identity = [
    xmlTag("source", input.source),
    xmlTag("type", input.type ?? "unknown"),
    input.rawKind ? xmlTag("raw_kind", input.rawKind) : "",
    xmlTag("receipt_id", input.receiptId),
  ];

  if (!doc) {
    return {
      role: "user",
      content: [
        '<trigger_event unavailable="true">',
        ...identity,
        xmlTag("unavailable_reason", "receipt_document_not_found"),
        "</trigger_event>",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const summary = getStringPath(doc.metadata, "summary");

  return {
    role: "user",
    content: [
      "<trigger_event>",
      ...identity,
      doc.title ? xmlTag("title", doc.title) : "",
      doc.authoredAt ? xmlTag("authored_at", doc.authoredAt.toISOString()) : "",
      doc.url ? xmlTag("url", doc.url) : "",
      summary ? xmlTag("summary", summary) : "",
      ...triggerEventExcerptTags(doc.content),
      "</trigger_event>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function triggerEventExcerptTags(content: string): string[] {
  const excerpt = content.slice(0, TRIGGER_EVENT_EXCERPT_CHARS);

  return [xmlTag("truncated", String(content.length > excerpt.length)), xmlTag("excerpt", excerpt)];
}

/** The Gmail trigger keys `<trigger_event>` keeps; others are dropped. */
interface TriggerMetadata {
  from?: JsonValue | undefined;
  to?: JsonValue | undefined;
  cc?: JsonValue | undefined;
  labelIds?: JsonValue | undefined;
  snippet?: JsonValue | undefined;
  historyId?: JsonValue | undefined;
  sizeEstimate?: JsonValue | undefined;
}

function pickTriggerMetadata(metadata: JsonObject): TriggerMetadata {
  return (
    ["from", "to", "cc", "labelIds", "snippet", "historyId", "sizeEstimate"] as const
  ).reduce<TriggerMetadata>((out, key) => {
    if (metadata[key] !== undefined) out[key] = metadata[key];

    return out;
  }, {});
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
