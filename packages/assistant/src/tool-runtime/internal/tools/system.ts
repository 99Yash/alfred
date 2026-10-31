import {
  appendArtifactPageInput,
  appendArtifactSectionInput,
  activateWorkflowInput,
  ASK_USER_LIMITS,
  askUserInput,
  askUserModelInput,
  authorWorkflowInput,
  createArtifactInput,
  editInstructionInput,
  forgetInstructionInput,
  listInstructionsInput,
  loadToolInput,
  currentTimeInput,
  promoteScratchInput,
  readScratchInput,
  readUserContextInput,
  recoverWorkflowInput,
  readChatHistoryInput,
  fetchUrlInput,
  rememberInput,
  searchToolsInput,
  resolveTodoInput,
  suggestTodoInput,
  updateArtifactInput,
  webSearchInput,
  writeScratchInput,
  awaitSubAgentInput,
  spawnSubAgentInput,
} from "@alfred/contracts";
import type { AskUserResult, IanaTimezone } from "@alfred/contracts";
import {
  appendArtifactPage,
  appendArtifactSection,
  createArtifact,
  updateArtifact,
  type ArtifactWriteContext,
} from "@alfred/assistant/artifacts";
import type {
  LiveChatToolExecuteContext,
  SystemToolScratchpad,
  ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";
import {
  activateWorkflow,
  authorWorkflow,
  callerLabel,
  editInstruction,
  forgetInstruction,
  listInstructions,
  readChatHistory,
  readChildRunOutcome,
  readUserContext,
  recoverWorkflow,
  rememberInstructionAndDismissTodos,
  checkInstruction,
  resolveTodo,
  scratchpad,
  spawnSubAgent,
  startToolLoadSpan,
  startToolSearchSpan,
  suggestTodo,
  webSearch,
} from "@alfred/assistant/tool-runtime";
import { inZone } from "@alfred/assistant/time";
import { redactCredentialUrl, runFetchUrl } from "./fetch-url";
import { liveTool, NO_TOOL_EFFECTS, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import {
  resolveExactToolLoad,
  searchAvailableTools,
} from "@alfred/assistant/tool-runtime/discovery";

/** The scratchpad this call reaches: the parent's for a sub-agent, written as the caller. */
function callerScratchpad(ctx: ToolExecuteContext): SystemToolScratchpad {
  return scratchpad({ runId: ctx.scratchpadRunId, writer: ctx.caller });
}

/** Artifact provenance from the chat turn. The message row does not exist yet, so the turn links it on finalize. */
function artifactWriteContext(ctx: LiveChatToolExecuteContext): ArtifactWriteContext {
  return { userId: ctx.userId, threadId: ctx.chat.threadId, runId: ctx.runId };
}

/** The instant plus the user's wall clock, for `system.current_time`. */
export function currentTimeSnapshot(timezone: IanaTimezone, now: Date = new Date()) {
  return {
    isoTime: now.toISOString(),
    ...inZone(timezone).clock(now),
    timezone,
  };
}

export const systemTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "search_tools",
    riskTier: "no_risk",
    replay: "safe",
    availability: { surface: "kernel" },
    description:
      "Search registered tools and connected MCP catalogs by capability. The result field loaded names the registered hit that is already loaded: call it directly on your next turn. Connected catalog hits instead return name mcp.call with an exact ref (connectionId, remoteName, catalogRevision); load mcp.call with system.load_tool and pass that ref's fields to invoke the remote tool.",
    discovery: {
      title: "Search tools",
      summary:
        "Find an available capability and its exact tool name without exposing full schemas.",
      aliases: ["find a tool", "discover tools", "tool catalog"],
      tags: ["tools", "capabilities", "discovery"],
      entities: ["tool", "capability"],
      verbs: ["search", "find", "discover"],
    },
    inputSchema: searchToolsInput,
    execute: async (input, ctx) => {
      const span = startToolSearchSpan({
        runId: ctx.runId,
        caller: callerLabel(ctx.caller),
        queryChars: input.query.length,
        startedAt: new Date(),
      });

      const startMs = Date.now();

      try {
        const candidates = await searchAvailableTools({
          userId: ctx.userId,
          query: input.query,
          limit: input.limit,
          allowedIntegrations: ctx.allowedIntegrations ?? [],
          context: ctx.runContext,
        });

        span.end({
          candidateNames: candidates.map((candidate) => candidate.name),
          latencyMs: Date.now() - startMs,
        });

        // Echo the query: a reloaded tool card has no `argsPreview` to show it.
        return { ok: true, query: input.query, candidates };
      } catch (error) {
        span.error();
        throw error;
      }
    },
    // The round folds the best hit the run may call. Test `name`, not `ref`: the curated
    // `mcp.call` entry has no ref. Search also ranks unavailable matches, so skip them.
    // An empty fold stores NULL, the same as a row from before the effects column.
    effects: (output) => {
      const names = output.candidates.flatMap((candidate) =>
        candidate.availability === "available" && candidate.name !== "mcp.call"
          ? [candidate.name]
          : [],
      );

      return names.length === 0 ? NO_TOOL_EFFECTS : { activation: { kind: "search_fold", names } };
    },
  }),
  liveTool({
    integration: "system",
    action: "load_tool",
    riskTier: "no_risk",
    replay: "safe",
    availability: { surface: "kernel" },
    description:
      "Load one exact available tool by the qualified name returned from system.search_tools. Prefer search_tools, which already loads its best registered hit; use this for a different name, including mcp.call for a connected-catalog ref. Its schema is available on the next model turn.",
    discovery: {
      title: "Load tool",
      summary: "Add one exact available tool to the run-local active surface for the next turn.",
      aliases: ["activate tool", "enable tool"],
      tags: ["tools", "capabilities", "discovery"],
      entities: ["tool", "capability"],
      verbs: ["load", "activate", "enable"],
      relatedTools: ["system.search_tools"],
    },
    inputSchema: loadToolInput,
    execute: async (input, ctx) => {
      const span = startToolLoadSpan({
        runId: ctx.runId,
        caller: callerLabel(ctx.caller),
        toolName: input.name,
        source: "model_load",
        startedAt: new Date(),
      });

      const startMs = Date.now();

      try {
        const result = await resolveExactToolLoad({
          userId: ctx.userId,
          name: input.name,
          allowedIntegrations: ctx.allowedIntegrations ?? [],
          context: ctx.runContext,
        });

        // A bare `{ ok: true }` here reads as "now loaded", so the model loads the same tool again.
        const alreadyActive = result.ok && ctx.activeTools.includes(result.name);

        span.end({
          outcome: alreadyActive ? "already_active" : result.ok ? "ok" : result.status,
          latencyMs: Date.now() - startMs,
        });

        if (alreadyActive) {
          return {
            ...result,
            alreadyActive: true,
            message: `${result.name} was already loaded, so this load changed nothing. Call ${result.name} directly; do not load it again.`,
          };
        }

        return result;
      } catch (error) {
        span.error();
        throw error;
      }
    },
    effects: (output) =>
      output.ok ? { activation: { kind: "load", name: output.name } } : NO_TOOL_EFFECTS,
  }),
  liveTool({
    integration: "system",
    action: "current_time",
    riskTier: "no_risk",
    replay: "safe",
    availability: { surface: "kernel" },
    description:
      "Return a live execution-time snapshot of the current instant and the user's local date, time, weekday, timezone, and UTC offset. In chat, use this live result over the turn-start runtime_context when an exact later instant matters.",
    discovery: {
      title: "Current time",
      summary: "Read the current time in the user's operational timezone.",
      aliases: ["what time is it", "today's date", "current date"],
      tags: ["time", "date", "temporal grounding"],
      entities: ["time", "date", "timezone"],
      verbs: ["read", "check"],
    },
    inputSchema: currentTimeInput,
    execute: async (_input, ctx) => currentTimeSnapshot(ctx.timezone),
  }),
  liveTool({
    integration: "system",
    action: "author_workflow",
    riskTier: "no_risk",
    replay: "unsafe",
    availability: { requiresLiveChat: true, callers: ["boss"] },
    description:
      "Save an inactive workflow draft and return its server-canonical activation input.",
    discovery: {
      title: "Author workflow",
      summary: "Save an editable workflow draft from a user's chat request.",
      aliases: ["create automation", "save recurring workflow", "draft workflow"],
      tags: ["workflow", "automation", "schedule"],
      entities: ["workflow", "automation"],
      verbs: ["author", "draft", "save"],
      relatedTools: ["system.activate_workflow"],
    },
    inputSchema: authorWorkflowInput,
    execute: async (input, ctx) =>
      authorWorkflow({
        userId: ctx.userId,
        runId: ctx.runId,
        timezone: ctx.timezone,
        input,
      }),
  }),
  liveTool({
    integration: "system",
    action: "recover_workflow",
    riskTier: "no_risk",
    replay: "safe",
    availability: { requiresLiveChat: true, callers: ["boss"] },
    description:
      "Revalidate one exact immutable workflow draft after setup and return the server-canonical activation proposal. Copy that proposal directly into system.activate_workflow; never reconstruct it.",
    discovery: {
      title: "Recover workflow",
      summary: "Resume a blocked workflow draft after connection or permission setup.",
      aliases: ["resume workflow recovery", "continue workflow activation"],
      tags: ["workflow", "recovery", "activation"],
      entities: ["workflow", "draft", "automation"],
      verbs: ["recover", "resume", "continue"],
      relatedTools: ["system.activate_workflow"],
    },
    inputSchema: recoverWorkflowInput,
    execute: async (input, ctx) =>
      recoverWorkflow({
        userId: ctx.userId,
        workflowId: input.workflowId,
        revisionId: input.revisionId,
      }),
  }),
  liveTool({
    integration: "system",
    action: "activate_workflow",
    riskTier: "high",
    replay: "unsafe",
    availability: { requiresLiveChat: true, callers: ["boss"] },
    description: "Publish the exact workflow definition in this editable approval contract.",
    discovery: {
      title: "Activate workflow",
      summary: "Publish an approved workflow revision and start its future occurrences.",
      aliases: ["approve automation", "publish workflow", "enable recurring workflow"],
      tags: ["workflow", "automation", "approval"],
      entities: ["workflow", "automation"],
      verbs: ["activate", "publish", "approve"],
      relatedTools: ["system.author_workflow"],
    },
    inputSchema: activateWorkflowInput,
    execute: async (input, ctx) =>
      activateWorkflow({
        userId: ctx.userId,
        input,
        createdByRunId: ctx.runId,
      }),
  }),
  liveTool({
    integration: "system",
    action: "read_chat_history",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Search or fetch bounded raw evidence from the current chat thread when the conversation summary is insufficient. Fetch messages, tool outcomes, or attachment representations by their stable IDs. This never accesses another thread.",
    // Kernel: the chat prompt names it, so a lazy load would cost a cache bust.
    availability: { surface: "kernel", requiresLiveChat: true },
    inputSchema: readChatHistoryInput,
    execute: async (input, ctx) =>
      readChatHistory({ userId: ctx.userId, threadId: ctx.chat.threadId, input }),
  }),
  liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Spawn one focused sub-agent run with an isolated brief. Reserve it for a subtask that needs its own multi-step investigation across several sources (memory + the user's accounts + the web, or a long open-ended research question). It costs a second model run and a join, and its tool calls are no more parallel than yours. Do NOT spawn one for a bounded lookup chain you can run directly — one search plus a batch or a few fetches from a single integration (a daily GitHub summary, today's calendar, one person's recent mail) is a direct call, not a delegation.",
    // Kernel: the boss prompt names it.
    availability: { surface: "kernel", callers: ["boss"] },
    inputSchema: spawnSubAgentInput,
    execute: async (input, ctx) => {
      const workflowAllowed = ctx.allowedIntegrations ?? [];
      const requestedAllowed = input.allowedIntegrations;

      if (
        workflowAllowed.length > 0 &&
        requestedAllowed.some((slug) => !workflowAllowed.includes(slug))
      ) {
        return {
          ok: false,
          status: "not_allowed",
          reason: "workflow_allowed_integrations_cap",
          allowedIntegrations: workflowAllowed,
        };
      }

      return await spawnSubAgent({
        parentRunId: ctx.runId,
        parentToolCallId: ctx.toolCallId,
        userId: ctx.userId,
        subId: input.subId,
        brief: input.brief,
        allowedIntegrations: requestedAllowed.length > 0 ? requestedAllowed : [...workflowAllowed],
        // Only a chat parent has one. The child streams its trail into that turn.
        chat: ctx.chat,
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "await_sub_agent",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Wait for a spawned sub-agent to finish and read its real result. Call this after system.spawn_sub_agent; it returns the child's terminal status, output, and any error. Never tell the user you'll notify them when a sub-agent is done later — there is no out-of-turn notification; await it here so the turn completes with the real result, or report honestly that it could not finish.",
    // Kernel: the prompt teaches spawn then await as one move.
    availability: { surface: "kernel", callers: ["boss"] },
    // ADR-0073: dispatch parks the parent on a running child. `execute` is the non-blocking fallback.
    staging: "join",
    inputSchema: awaitSubAgentInput,
    execute: async (input, ctx) => {
      return await readChildRunOutcome({
        parentRunId: ctx.runId,
        userId: ctx.userId,
        childRunId: input.childRunId,
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "ask_user",
    riskTier: "no_risk",
    replay: "safe",
    description:
      `Ask the user ${ASK_USER_LIMITS.questions.min} to ${ASK_USER_LIMITS.questions.max} questions and wait for the answers before you continue. ` +
      "Ask only when the request is ambiguous and a wrong guess would waste work; never ask for something you can look up. " +
      "Never ask whether to make a call that the connected-integrations list marks as waiting for approval; its approval card already asks. " +
      "If your reply would end by asking the user to choose or to supply something you need to finish, call this instead. " +
      "This includes an open answer, such as names or a list: offer the likeliest choices as options, and the free-text answer takes the rest. " +
      "Ask every question in one call, because each call pauses the turn. " +
      `Give each question ${ASK_USER_LIMITS.options.min} to ${ASK_USER_LIMITS.options.max} options. Put the option you recommend first and end its label with "(Recommended)". ` +
      "Never add an option that only invites free text, such as 'Other' or 'Name them'; the card always adds a free-text answer. " +
      "Never put a question for the user in a sub-agent brief; ask here first. Never fill `answers` yourself.",
    // A question needs a person on a live thread. Kernel: the prompt sends every ambiguous request here.
    availability: { surface: "kernel", requiresLiveChat: true, callers: ["boss"] },
    // ADR-0099: `execute` runs only on resume. An approval with no edit has no answers.
    staging: "question",
    // The runtime schema accepts `answers`; the model schema hides it, or the model fills it.
    inputSchema: askUserInput,
    modelInputSchema: askUserModelInput,
    execute: async (input): Promise<AskUserResult> => {
      if (input.answers === undefined) {
        return {
          status: "unanswered",
          reason: "no_answers",
          questions: input.questions,
          message:
            "The user resumed the turn without answering. Continue on a reasonable assumption and state it in one sentence.",
        };
      }

      return { status: "answered", questions: input.questions, answers: input.answers };
    },
  }),
  liveTool({
    integration: "system",
    action: "read_user_context",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Read Alfred's compact, bounded user context: profile, confirmed facts, preferences, known people/entities, relationship edges, and recent memory. Use before answering questions about people, relationships, standing instructions, preferences, or personal context.",
    // Kernel: it has no intent-bearing discovery metadata, so it would never preload.
    availability: { surface: "kernel" },
    inputSchema: readUserContextInput,
    execute: async (input, ctx) => {
      return await readUserContext({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "read_scratch",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Read a value from the run scratchpad using shared.<path> or scratch.<subId>.<path>.",
    staging: "fast_path",
    inputSchema: readScratchInput,
    refuseInput: (input, ctx) => callerScratchpad(ctx).refusal({ verb: "read", key: input.key }),
    execute: async (input, ctx) => {
      const entry = await callerScratchpad(ctx).read(input.key);

      if (!entry) return { ok: true, key: input.key, found: false };

      return { ok: true, key: input.key, found: true, entry };
    },
  }),
  liveTool({
    integration: "system",
    action: "write_scratch",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Write a value to the run scratchpad using shared.<path> or scratch.<subId>.<path>.",
    staging: "fast_path",
    inputSchema: writeScratchInput,
    refuseInput: (input, ctx) => callerScratchpad(ctx).refusal({ verb: "write", key: input.key }),
    execute: async (input, ctx) => {
      const { writtenBy } = await callerScratchpad(ctx).write(input.key, input.value);

      return { ok: true, key: input.key, writtenBy };
    },
  }),
  liveTool({
    integration: "system",
    action: "promote",
    riskTier: "no_risk",
    replay: "safe",
    description: "Copy a sub-agent scratch value into the boss-owned shared scratchpad.",
    availability: { callers: ["boss"] },
    staging: "fast_path",
    inputSchema: promoteScratchInput,
    refuseInput: (input, ctx) =>
      callerScratchpad(ctx).refusal({
        verb: "promote",
        fromKey: input.fromKey,
        toKey: input.toKey,
      }),
    execute: async (input, ctx) => {
      const entry = await callerScratchpad(ctx).promote(input.fromKey, input.toKey);

      if (!entry) return { ok: true, promoted: false, fromKey: input.fromKey, toKey: input.toKey };

      return { ok: true, promoted: true, fromKey: input.fromKey, toKey: input.toKey, entry };
    },
  }),
  liveTool({
    integration: "system",
    action: "remember",
    riskTier: "no_risk",
    replay: "unsafe",
    // ADR-0113: the card is the one-line confirmation, also under full autonomy.
    staging: "confirm",
    availability: { requiresLiveChat: true },
    description:
      "Store a standing instruction the user stated in chat (ADR-0113). The user confirms it on " +
      "a card before it is stored, so do not ask again in text. Put the user's words in " +
      "`phrasing`. When the words name a class of mail ('investment mail', 'Dependabot " +
      "alerts'), put that class in `scope`: triage matches it by meaning, so a new sender is " +
      "covered. Put a sender in `targets` only when the words name that sender; never expand " +
      "a class into senders from past mail. Choose only the `effects` the words ask for. Call " +
      "list_instructions first: to change an instruction, pass its `instructionId` and its " +
      "`revision` as `expectedRevision`; for an exception to a broader one, pass `exceptionOf`. " +
      "An active instruction on the same, a wider, a narrower, or an overlapping sender is a " +
      "conflict: ask the user to replace it (`replaces`), " +
      "make the new one an exception to it (`exceptionOf`), or keep both (`coexistsWith`). " +
      "With no choice, the call stores nothing and returns `conflict`. Emails still arrive " +
      "in Gmail.",
    inputSchema: rememberInput,
    // Refuse before the card, so the user never confirms an input that capture refuses.
    // The write decides again under its lock. A failed check leaves that decision to the write.
    refuseProposal: async (input, ctx) => {
      const refusal = await checkInstruction({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      }).catch(() => null);

      return refusal === null ? null : JSON.stringify(refusal);
    },
    execute: async (input, ctx) => {
      return await rememberInstructionAndDismissTodos({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "list_instructions",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "List the user's active standing instructions (each with its `factId`, `instructionId`, " +
      "`schemaVersion`, scope, targets, effects, and directive). Call this before forgetting, " +
      "editing, or revising one so you target the right id, and " +
      "to check whether a new request duplicates or conflicts with an existing instruction. The result " +
      "is capped; if `truncated` is true and the target is unclear, ask the user to narrow it.",
    inputSchema: listInstructionsInput,
    execute: async (input, ctx) => {
      return await listInstructions({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "forget_instruction",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Remove a standing instruction the user explicitly asked you to drop, by its `factId` (from " +
      "list_instructions). Non-destructive — the instruction is retired, not erased. If you're not " +
      "sure which instruction the user means, list them and ask rather than guessing.",
    inputSchema: forgetInstructionInput,
    execute: async (input, ctx) => {
      return await forgetInstruction({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "edit_instruction",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Reframe a schemaVersion 1 standing instruction's wording or display label, by its `factId` " +
      "(from list_instructions), without changing what it targets. Revise a schemaVersion 2 " +
      "instruction with system.remember and its `instructionId` instead. To point an instruction at a different " +
      "sender, forget the wrong one and remember the right one instead. A row that targets a DOMAIN " +
      "takes neither edit — its sentence comes from the domain and it carries no display label — and " +
      "returns what it ignored under `droppedInputs`. Tell the user.",
    inputSchema: editInstructionInput,
    execute: async (input, ctx) => {
      return await editInstruction({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "resolve_todo",
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Dismiss live todos by resolved Gmail sender or Gmail thread source. Use after storing a sender suppression so current matching todos disappear instead of lingering.",
    inputSchema: resolveTodoInput,
    execute: async (input, ctx) => {
      return await resolveTodo({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "suggest_todo",
    // A suggestion has no outside effect (ADR-0050). The todo row is the audit.
    riskTier: "no_risk",
    replay: "unsafe",
    description:
      "Propose a todo for the user's quick rail. Inserts a 'suggested' row the user can accept or dismiss — it never acts on the user's behalf. Idempotent: if a live todo already references one of the given sources, the refs merge into it instead of duplicating. A Gmail thread the user has already answered is suppressed (status 'suppressed', reason 'user_already_replied') — the loop is closed, so do not ask the user to reply again.",
    inputSchema: suggestTodoInput,
    execute: async (input, ctx) => {
      return await suggestTodo({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "web_search",
    // Cost is logged under api_call_log.kind = 'web_search'.
    riskTier: "no_risk",
    replay: "safe",
    // Kernel: a hot path for person and company research.
    availability: { surface: "kernel" },
    description:
      "Search the live web and get back what the search found: a synthesized answer, source results/citations behind it (open a result URL with fetch_url to read the page in full), and the queries actually run. Use this for current events, facts you're unsure of, or public background on a person or company — don't guess from memory when a lookup would settle it. It surfaces candidate matches even when uncertain rather than stopping at 'no confident match', so treat a thin result as a cue to search a different angle or drill a source, not a dead end.",
    inputSchema: webSearchInput,
    execute: async (input, ctx) => {
      return await webSearch({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "fetch_url",
    // ADR-0071: text only, size-bounded, binary reported, host-guarded for SSRF.
    riskTier: "no_risk",
    replay: "safe",
    description:
      "Read the contents of a known http(s) URL in as sanitized text. Use this when you already hold a link (from the user, read_user_context, or a prior tool result) and need what the page actually says — 'read my website', 'summarize this page', 'what does this link say'. This reads a page you can name; use web_search to discover sources for a question instead. Reads JavaScript-rendered pages too (X/Twitter profiles and tweets, and other single-page apps): when the plain read comes back empty it re-fetches through a headless renderer, so prefer it over web_search for 'what's in his bio', 'read his recent tweets' — web_search only sees lagged second-hand commentary about X. Returns readable text (HTML stripped), the page title, and the final URL; binary resources (PDFs, images) are reported honestly, not downloaded.",
    inputSchema: fetchUrlInput,
    execute: async (input) => {
      return await runFetchUrl({ url: input.url });
    },
    // Scrub credential values from the URL before it reaches a trace or a staging row.
    redactInput: (input) => ({ ...input, url: redactCredentialUrl(input.url) }),
  }),
  liveTool({
    integration: "system",
    action: "create_artifact",
    executionLane: "artifact_mutation",
    artifactStream: "replace",
    riskTier: "no_risk",
    replay: "unsafe",
    description:
      "Produce a rich artifact the user reads in a side panel: a written `document` (markdown) or a deck/PDF of `pages` (HTML). Use this when the user asks you to write, draft, or build something substantial, instead of dumping it all into the chat reply. Pick the medium by how the deliverable is meant to be consumed, not by which looks more impressive: if it is read as prose — a brief, an overview, a primer, a report, notes, an explainer, a write-up — author a `document`. Reserve `pages` for deliverables that are inherently presentational or visually laid out — a slide deck or presentation to show, a pitch, a designed one-pager, a résumé, a printable PDF. When the ask is ambiguous, default to `document`: it is the right home for reading material and far cheaper to produce, so only reach for `pages` when the user actually signals slides, a deck, a presentation, or a designed/printable page. Opens the artifact; for a `document` author the opening section here (≤~1,800 words) and continue with append_artifact_section — do not attempt the whole document in one call; for `pages` follow with append_artifact_page per page. Each page is body-level HTML authored against the Alfred house shell: write only the page body, not a full standalone document. This is in-app content, not a downloadable file.",
    availability: { requiresLiveChat: true },
    inputSchema: createArtifactInput,
    execute: async (input, ctx) => await createArtifact(artifactWriteContext(ctx), input),
    effects: (output) => ({ artifactId: output.artifactId }),
  }),
  liveTool({
    integration: "system",
    action: "append_artifact_page",
    executionLane: "artifact_mutation",
    riskTier: "no_risk",
    replay: "unsafe",
    description:
      "Append one page to a `pages` artifact created with create_artifact. Call once per page, in order. Write body-level HTML only: never emit <html>, <head>, <body>, <!doctype>, <script>, external <link>/CDN tags, page width/height, page margins, or a body background. The Alfred house shell supplies page geometry, white surface, typography, tokens, and classes at render time. Preferred classes: art-stack, art-row, art-grid-2, art-split, art-center, art-between, art-fill, art-grow, art-wrap; art-display, art-title, art-headline, art-subhead, art-body, art-caption, art-eyebrow; art-card, art-panel, art-badge, art-rule, art-accent-mark, art-dot, art-list, art-stat-value, art-stat-label, art-bar-track, art-bar-fill. For a `pdf` document (resume, report, one-pager) use the denser document vocabulary instead of the big slide type: the first content wrapper must be art-doc, then compose with art-doc-name, art-doc-role, art-doc-section, art-doc-heading, art-doc-body, art-doc-meta, art-doc-header, art-doc-contact, art-doc-lede, art-doc-entry, art-doc-cols, art-doc-chips, and art-doc-rule. PDF pages that override --art-* tokens or declare custom font, font-family, or font-size values are rejected. Keep everything inside the fixed page box; there is no scrolling. Use one idea per page, split crowded content, keep code blocks short, and use a small inline <style> only for one-off geometry (reference the design tokens, never hardcode colors). Pages appear in the sidebar as you add them.",
    availability: { requiresLiveChat: true },
    inputSchema: appendArtifactPageInput,
    execute: async (input, ctx) => await appendArtifactPage(artifactWriteContext(ctx), input),
    effects: (output) => (output.ok ? { artifactId: output.artifactId } : NO_TOOL_EFFECTS),
  }),
  liveTool({
    integration: "system",
    action: "append_artifact_section",
    executionLane: "artifact_mutation",
    artifactStream: "append",
    riskTier: "no_risk",
    replay: "unsafe",
    description:
      "Append one section of markdown to a `document` created with create_artifact. Call once per section, in order — do not attempt the whole document in one call; each section renders in the sidebar as you add it. Write your own `##` headings and keep each section self-contained (close every code fence, finish every list/table) since the sidebar re-renders the accumulated document as each section arrives. Also use this to extend a document from an earlier turn.",
    availability: { requiresLiveChat: true },
    inputSchema: appendArtifactSectionInput,
    execute: async (input, ctx) => await appendArtifactSection(artifactWriteContext(ctx), input),
    effects: (output) => (output.ok ? { artifactId: output.artifactId } : NO_TOOL_EFFECTS),
  }),
  liveTool({
    integration: "system",
    action: "update_artifact",
    executionLane: "artifact_mutation",
    artifactStream: "replace",
    riskTier: "no_risk",
    replay: "unsafe",
    description:
      "Revise an existing artifact: rename it, make targeted text edits, replace a document's markdown, or replace a deck's full page list. Use this when the user asks to change content you already produced this conversation. To add a section or page at the end, use append_artifact_section or append_artifact_page instead. For a targeted change, send `edits`: exact oldString/newString pairs that save together, so you resend only what changes. Replace the full markdown or pages only for a broad rewrite. For cross-turn content replacement, work only from a reference with contentComplete=true and copy its baseContentHash; never replace content from a partial reference. Rename-only edits and `edits` need no hash.",
    availability: { requiresLiveChat: true },
    inputSchema: updateArtifactInput,
    execute: async (input, ctx) => await updateArtifact(artifactWriteContext(ctx), input),
    effects: (output) => (output.ok ? { artifactId: output.artifactId } : NO_TOOL_EFFECTS),
  }),
];
