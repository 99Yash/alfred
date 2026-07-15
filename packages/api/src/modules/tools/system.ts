import {
  appendArtifactPageInput,
  appendArtifactSectionInput,
  createArtifactInput,
  editInstructionInput,
  forgetInstructionInput,
  isLoadableIntegrationSlug,
  listInstructionsInput,
  loadToolInput,
  currentTimeInput,
  promoteScratchInput,
  readScratchInput,
  readUserContextInput,
  readChatHistoryInput,
  fetchUrlInput,
  rememberInput,
  searchToolsInput,
  resolveTodoInput,
  suggestTodoInput,
  updateArtifactInput,
  webSearchInput,
  writeScratchInput,
} from "@alfred/contracts";
import { AppError } from "../../lib/app-errors";
import {
  appendArtifactPage,
  appendArtifactSection,
  createArtifact,
  updateArtifact,
  type ArtifactWriteContext,
} from "../artifacts/write";
import {
  awaitSubAgentInputSchema,
  readChildRunOutcome,
  spawnSubAgent,
  spawnSubAgentInputSchema,
} from "../agent/sub-agents";
import type { ToolExecuteContext } from "./registry";
import { readUserContext } from "../memory/user-context";
import { readChatHistory } from "../agent/compaction";
import {
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  rememberSenderSuppression,
} from "../memory/standing-instructions";
import { promoteScratch, readScratch, writeScratch } from "../scratchpad";
import { resolveTodosForGmailSender } from "../todos/resolve";
import { suggestTodo } from "../todos/suggest";
import { redactCredentialUrl, runFetchUrl } from "./fetch-url";
import { liveTool, type RegisteredTool } from "./registry";
import { parseScratchToolKey } from "./scratch-key";
import { runWebSearch } from "./web-search";
import { resolveExactToolLoad, searchAvailableTools } from "./discovery";

/**
 * Resolve the provenance an artifact tool needs from the call context. Returns
 * an honest refusal (not a throw) when the call didn't come from a chat turn —
 * an artifact is owned by the thread/run that produced it, so a
 * background/sub-agent run has nowhere to attach one (ADR-0075). A live
 * `messageId` is required as proof this is an interactive chat turn. It is
 * associated with the artifact only when the turn finalizes because its row
 * does not exist during tool execution.
 */
function resolveArtifactContext(
  ctx: ToolExecuteContext,
): { ok: true; ctx: ArtifactWriteContext } | { ok: false; result: unknown } {
  if (!ctx.threadId || !ctx.messageId) {
    return {
      ok: false,
      result: {
        ok: false,
        status: "no_thread",
        reason:
          "Artifacts can only be authored inside a chat conversation; this run has no chat thread.",
      },
    };
  }
  return {
    ok: true,
    ctx: {
      userId: ctx.userId,
      threadId: ctx.threadId,
      runId: ctx.runId,
    },
  };
}

export function currentTimeSnapshot(timezone: string, now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const offset = part("timeZoneName");
  const offsetMatch = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(
    offset,
  );
  const utcOffset = offsetMatch?.groups?.sign
    ? `${offsetMatch.groups.sign}${(offsetMatch.groups.hours ?? "0").padStart(2, "0")}:${offsetMatch.groups.minutes ?? "00"}`
    : "+00:00";

  return {
    isoTime: now.toISOString(),
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localTime: `${part("hour")}:${part("minute")}:${part("second")}`,
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(now),
    timezone,
    utcOffset,
  };
}

export const systemTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "search_tools",
    riskTier: "no_risk",
    availability: { surface: "kernel" },
    description:
      "Search the available tool catalog by capability without loading full schemas. Returns exact names for system.load_tool.",
    discovery: {
      title: "Search tools",
      summary:
        "Find an available capability and its exact tool name without exposing full schemas.",
      aliases: ["find a tool", "discover tools", "tool catalog"],
      tags: ["tools", "capabilities", "discovery"],
      entities: ["tool", "capability"],
      verbs: ["search", "find", "discover"],
      relatedTools: ["system.load_tool"],
    },
    inputSchema: searchToolsInput,
    execute: async (input, ctx) => ({
      ok: true,
      candidates: await searchAvailableTools({
        userId: ctx.userId,
        query: input.query,
        limit: input.limit,
        allowedIntegrations: ctx.allowedIntegrations ?? [],
        context: {
          caller: ctx.caller === "boss" ? "boss" : "sub_agent",
          hasThread: !!ctx.threadId,
        },
      }),
    }),
  }),
  liveTool({
    integration: "system",
    action: "load_tool",
    riskTier: "no_risk",
    availability: { surface: "kernel" },
    description:
      "Load one exact available tool by the qualified name returned from system.search_tools. Its schema is available on the next model turn.",
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
    execute: async (input, ctx) =>
      resolveExactToolLoad({
        userId: ctx.userId,
        name: input.name,
        allowedIntegrations: ctx.allowedIntegrations ?? [],
        context: {
          caller: ctx.caller === "boss" ? "boss" : "sub_agent",
          hasThread: !!ctx.threadId,
        },
      }),
  }),
  liveTool({
    integration: "system",
    action: "current_time",
    riskTier: "no_risk",
    availability: { surface: "kernel" },
    description:
      "Return the current instant and the user's local date, time, weekday, timezone, and UTC offset.",
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
    action: "read_chat_history",
    riskTier: "no_risk",
    description:
      "Search or fetch bounded raw evidence from the current chat thread when the conversation summary is insufficient. Fetch messages, tool outcomes, or attachment representations by their stable IDs. This never accesses another thread.",
    availability: { requiresThread: true },
    inputSchema: readChatHistoryInput,
    execute: async (input, ctx) => {
      if (!ctx.threadId) {
        return {
          ok: false,
          status: "no_thread",
          reason: "Conversation history is available only inside the current chat thread.",
        };
      }
      return readChatHistory({ userId: ctx.userId, threadId: ctx.threadId, input });
    },
  }),
  liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    description: "Spawn one focused sub-agent run with an isolated brief.",
    availability: { callers: ["boss"] },
    inputSchema: spawnSubAgentInputSchema,
    execute: async (input, ctx) => {
      const workflowAllowed = (ctx.allowedIntegrations ?? []).filter(isLoadableIntegrationSlug);
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
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "await_sub_agent",
    riskTier: "no_risk",
    description:
      "Wait for a spawned sub-agent to finish and read its real result. Call this after system.spawn_sub_agent; it returns the child's terminal status, output, and any error. Never tell the user you'll notify them when a sub-agent is done later — there is no out-of-turn notification; await it here so the turn completes with the real result, or report honestly that it could not finish.",
    availability: { callers: ["boss"] },
    inputSchema: awaitSubAgentInputSchema,
    // The dispatcher (dispatch/index.ts) intercepts this tool to park the parent
    // on a child-completion signal when the child is still running (ADR-0073).
    // This execute is the read-only fallback (terminal children, or a direct
    // call that bypasses the dispatcher); it never blocks.
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
    action: "read_user_context",
    riskTier: "no_risk",
    description:
      "Read Alfred's compact, bounded user context: profile, confirmed facts, preferences, known people/entities, relationship edges, and recent memory. Use before answering questions about people, relationships, standing instructions, preferences, or personal context.",
    inputSchema: readUserContextInput,
    execute: async (input, ctx) => {
      return await readUserContext(ctx.userId, {
        subjectEmail: input.subjectEmail,
        query: input.query,
        include: input.include,
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "read_scratch",
    riskTier: "no_risk",
    description:
      "Read a value from the run scratchpad using shared.<path> or scratch.<subId>.<path>.",
    inputSchema: readScratchInput,
    execute: async (input, ctx) => {
      const target = parseScratchToolKey(input.key);
      const entry =
        target.zone === "shared"
          ? await readScratch({ runId: ctx.scratchpadRunId, zone: "shared", path: target.path })
          : await readScratch({
              runId: ctx.scratchpadRunId,
              zone: "scratch",
              subId: target.subId,
              path: target.path,
            });

      if (!entry) return { ok: true, key: input.key, found: false };
      return { ok: true, key: input.key, found: true, entry };
    },
  }),
  liveTool({
    integration: "system",
    action: "write_scratch",
    riskTier: "no_risk",
    description:
      "Write a value to the run scratchpad using shared.<path> or scratch.<subId>.<path>.",
    inputSchema: writeScratchInput,
    execute: async (input, ctx) => {
      const target = parseScratchToolKey(input.key);
      const writtenBy = ctx.caller === "boss" ? "boss" : ctx.caller.subId;
      if (target.zone === "shared") {
        await writeScratch({
          runId: ctx.scratchpadRunId,
          zone: "shared",
          path: target.path,
          value: input.value,
          writtenBy,
        });
      } else {
        await writeScratch({
          runId: ctx.scratchpadRunId,
          zone: "scratch",
          subId: target.subId,
          path: target.path,
          value: input.value,
          writtenBy,
        });
      }
      return { ok: true, key: input.key, writtenBy };
    },
  }),
  liveTool({
    integration: "system",
    action: "promote",
    riskTier: "no_risk",
    description: "Copy a sub-agent scratch value into the boss-owned shared scratchpad.",
    availability: { callers: ["boss"] },
    inputSchema: promoteScratchInput,
    execute: async (input, ctx) => {
      const from = parseScratchToolKey(input.fromKey);
      const to = parseScratchToolKey(input.toKey);
      if (from.zone !== "scratch" || to.zone !== "shared") {
        throw new AppError("tool_input_invalid");
      }

      const entry = await promoteScratch({
        runId: ctx.scratchpadRunId,
        fromSubId: from.subId,
        fromPath: from.path,
        toSharedPath: to.path,
      });
      if (!entry) return { ok: true, promoted: false, fromKey: input.fromKey, toKey: input.toKey };
      return { ok: true, promoted: true, fromKey: input.fromKey, toKey: input.toKey, entry };
    },
  }),
  liveTool({
    integration: "system",
    action: "remember",
    riskTier: "no_risk",
    description:
      "Persist a resolved sender-level suppression standing instruction. Only persists when the sender email is resolved; otherwise returns a clarification request.",
    inputSchema: rememberInput,
    execute: async (input, ctx) => {
      return await rememberSenderSuppression({
        userId: ctx.userId,
        senderEmail: input.senderEmail,
        senderLabel: input.senderLabel,
        accountId: input.accountId ?? null,
        directive: input.directive,
        phrasing: input.phrasing,
        source: {
          kind: "tool_call",
          id: ctx.toolCallId,
          meta: {
            runId: ctx.runId,
            stepId: ctx.stepId,
          },
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "list_instructions",
    riskTier: "no_risk",
    description:
      "List the user's active standing instructions (each with its `factId`, target, effects, and " +
      "directive). Call this before forgetting or editing one so you target the right `factId`, and " +
      "to check whether a new request duplicates or conflicts with an existing instruction. The result " +
      "is capped; if `truncated` is true and the target is unclear, ask the user to narrow it.",
    inputSchema: listInstructionsInput,
    execute: async (_input, ctx) => {
      return await listStandingInstructions(ctx.userId);
    },
  }),
  liveTool({
    integration: "system",
    action: "forget_instruction",
    riskTier: "no_risk",
    description:
      "Remove a standing instruction the user explicitly asked you to drop, by its `factId` (from " +
      "list_instructions). Non-destructive — the instruction is retired, not erased. If you're not " +
      "sure which instruction the user means, list them and ask rather than guessing.",
    inputSchema: forgetInstructionInput,
    execute: async (input, ctx) => {
      return await forgetStandingInstruction({
        userId: ctx.userId,
        factId: input.factId,
        reason: input.reason,
        source: {
          kind: "tool_call",
          id: ctx.toolCallId,
          meta: { runId: ctx.runId, stepId: ctx.stepId },
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "edit_instruction",
    riskTier: "no_risk",
    description:
      "Reframe an existing standing instruction's wording or display label, by its `factId` (from " +
      "list_instructions), without changing what it targets. To point an instruction at a different " +
      "sender, forget the wrong one and remember the right one instead.",
    inputSchema: editInstructionInput,
    execute: async (input, ctx) => {
      return await editStandingInstruction({
        userId: ctx.userId,
        factId: input.factId,
        directive: input.directive,
        senderLabel: input.senderLabel,
        source: {
          kind: "tool_call",
          id: ctx.toolCallId,
          meta: { runId: ctx.runId, stepId: ctx.stepId },
        },
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "resolve_todo",
    riskTier: "no_risk",
    description:
      "Dismiss live todos by resolved Gmail sender or Gmail thread source. Use after storing a sender suppression so current matching todos disappear instead of lingering.",
    inputSchema: resolveTodoInput,
    execute: async (input, ctx) => {
      return await resolveTodosForGmailSender({
        userId: ctx.userId,
        senderEmail: input.senderEmail,
        sourceThreadId: input.sourceThreadId,
        accountId: input.accountId ?? null,
        reason: input.reason,
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "suggest_todo",
    // no_risk + system integration (autonomy) → never gated. A suggestion has
    // no real-world side effect, so it stays off the approvals HIL path
    // (ADR-0050); audit lives on the todo row.
    riskTier: "no_risk",
    description:
      "Propose a todo for the user's quick rail. Inserts a 'suggested' row the user can accept or dismiss — it never acts on the user's behalf. Idempotent: if a live todo already references one of the given sources, the refs merge into it instead of duplicating.",
    inputSchema: suggestTodoInput,
    execute: async (input, ctx) => {
      return await suggestTodo({
        userId: ctx.userId,
        agentRunId: ctx.runId,
        name: input.name,
        description: input.description,
        assist: input.assist,
        sources: input.sources,
      });
    },
  }),
  liveTool({
    integration: "system",
    action: "web_search",
    // Read-only external lookup with no side effect on the user's accounts.
    // `system.*` tools are always dispatched in autonomy mode, so this never awaits approval.
    // Cost is bucketed under api_call_log.kind = 'web_search', not the gate.
    riskTier: "no_risk",
    description:
      "Search the live web and get back what the search found: a synthesized answer, source results/citations behind it (open a result URL with fetch_url to read the page in full), and the queries actually run. Use this for current events, facts you're unsure of, or public background on a person or company — don't guess from memory when a lookup would settle it. It surfaces candidate matches even when uncertain rather than stopping at 'no confident match', so treat a thin result as a cue to search a different angle or drill a source, not a dead end.",
    inputSchema: webSearchInput,
    execute: async (input, ctx) => {
      const { answer, citations, results, searchQueries } = await runWebSearch({
        query: input.query,
        userId: ctx.userId,
        runId: ctx.runId,
        stepId: ctx.stepId,
        idempotencyKey: ctx.toolCallId,
      });
      return { ok: true, query: input.query, answer, citations, results, searchQueries };
    },
  }),
  liveTool({
    integration: "system",
    action: "fetch_url",
    // Read-only external fetch with no side effect on the user's accounts —
    // like web_search, `system.*` tools dispatch in autonomy mode so this never
    // awaits approval. Honest read-in (ADR-0071): text only, size-bounded,
    // binary resources reported rather than garbled; host-guarded for SSRF.
    riskTier: "no_risk",
    description:
      "Read the contents of a known http(s) URL in as sanitized text. Use this when you already hold a link (from the user, read_user_context, or a prior tool result) and need what the page actually says — 'read my website', 'summarize this page', 'what does this link say'. This reads a page you can name; use web_search to discover sources for a question instead. Returns readable text (HTML stripped), the page title, and the final URL; binary resources (PDFs, images) are reported honestly, not downloaded.",
    inputSchema: fetchUrlInput,
    execute: async (input) => {
      return await runFetchUrl({ url: input.url });
    },
    // #293: the tool owns sensitivity — scrub credential-bearing query/fragment
    // values from the URL before the dispatcher persists it to a sink (span
    // always; proposed_input when autonomous). The hash + execute still see the
    // raw URL, so idempotency and the in-tool credential block are unaffected.
    redactInput: (input) => ({ ...input, url: redactCredentialUrl(input.url) }),
  }),
  liveTool({
    integration: "system",
    action: "create_artifact",
    // Authors a synced artifact row for the user's own sidebar — no external
    // side effect, so it stays off the approvals path like other system tools.
    riskTier: "no_risk",
    description:
      "Produce a rich artifact the user reads in a side panel: a written `document` (markdown) or a deck/PDF of `pages` (HTML). Use this when the user asks you to write, draft, or build something substantial, instead of dumping it all into the chat reply. Pick the medium by how the deliverable is meant to be consumed, not by which looks more impressive: if it is read as prose — a brief, an overview, a primer, a report, notes, an explainer, a write-up — author a `document`. Reserve `pages` for deliverables that are inherently presentational or visually laid out — a slide deck or presentation to show, a pitch, a designed one-pager, a résumé, a printable PDF. When the ask is ambiguous, default to `document`: it is the right home for reading material and far cheaper to produce, so only reach for `pages` when the user actually signals slides, a deck, a presentation, or a designed/printable page. Opens the artifact; for a `document` author the opening section here (≤~1,800 words) and continue with append_artifact_section — do not attempt the whole document in one call; for `pages` follow with append_artifact_page per page. Each page is body-level HTML authored against the Alfred house shell: write only the page body, not a full standalone document. This is in-app content, not a downloadable file.",
    availability: { requiresThread: true },
    inputSchema: createArtifactInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await createArtifact(resolved.ctx, input);
    },
  }),
  liveTool({
    integration: "system",
    action: "append_artifact_page",
    riskTier: "no_risk",
    description:
      "Append one page to a `pages` artifact created with create_artifact. Call once per page, in order. Write body-level HTML only: never emit <html>, <head>, <body>, <!doctype>, <script>, external <link>/CDN tags, page width/height, page margins, or a body background. The Alfred house shell supplies page geometry, white surface, typography, tokens, and classes at render time. Preferred classes: art-stack, art-row, art-grid-2, art-split, art-center, art-between, art-fill, art-grow, art-wrap; art-display, art-title, art-headline, art-subhead, art-body, art-caption, art-eyebrow; art-card, art-panel, art-badge, art-rule, art-accent-mark, art-dot, art-list, art-stat-value, art-stat-label, art-bar-track, art-bar-fill. For a `pdf` document (resume, report, one-pager) use the denser document vocabulary instead of the big slide type: the first content wrapper must be art-doc, then compose with art-doc-name, art-doc-role, art-doc-section, art-doc-heading, art-doc-body, art-doc-meta, art-doc-header, art-doc-contact, art-doc-lede, art-doc-entry, art-doc-cols, art-doc-chips, and art-doc-rule. PDF pages that override --art-* tokens or declare custom font, font-family, or font-size values are rejected. Keep everything inside the fixed page box; there is no scrolling. Use one idea per page, split crowded content, keep code blocks short, and use a small inline <style> only for one-off geometry (reference the design tokens, never hardcode colors). Pages appear in the sidebar as you add them.",
    availability: { requiresThread: true },
    inputSchema: appendArtifactPageInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await appendArtifactPage(resolved.ctx, input);
    },
  }),
  liveTool({
    integration: "system",
    action: "append_artifact_section",
    riskTier: "no_risk",
    description:
      "Append one section of markdown to a `document` created with create_artifact. Call once per section, in order — do not attempt the whole document in one call; each section renders in the sidebar as you add it. Write your own `##` headings and keep each section self-contained (close every code fence, finish every list/table) since the sidebar re-renders the accumulated document as each section arrives. Also use this to extend a document from an earlier turn.",
    availability: { requiresThread: true },
    inputSchema: appendArtifactSectionInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await appendArtifactSection(resolved.ctx, input);
    },
  }),
  liveTool({
    integration: "system",
    action: "update_artifact",
    riskTier: "no_risk",
    description:
      "Revise an existing artifact: rename it, replace a document's markdown, or replace a deck's full page list. Use this when the user asks for an edit to something you already produced this conversation. For cross-turn content replacement, work only from a reference with contentComplete=true and copy its baseContentHash; never replace content from a partial reference. Rename-only edits need no hash.",
    availability: { requiresThread: true },
    inputSchema: updateArtifactInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await updateArtifact(resolved.ctx, input);
    },
  }),
];
