import {
  appendArtifactPageInput,
  createArtifactInput,
  isLoadableIntegrationSlug,
  loadIntegrationInput,
  promoteScratchInput,
  readScratchInput,
  readUserContextInput,
  rememberInput,
  resolveTodoInput,
  suggestTodoInput,
  updateArtifactInput,
  webSearchInput,
  writeScratchInput,
} from "@alfred/contracts";
import {
  appendArtifactPage,
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
import { rememberSenderSuppression } from "../memory/standing-instructions";
import { promoteScratch, readScratch, writeScratch } from "../scratchpad";
import { resolveTodosForGmailSender } from "../todos/resolve";
import { suggestTodo } from "../todos/suggest";
import { liveTool, type RegisteredTool } from "./registry";
import { parseScratchToolKey } from "./scratch-key";
import { runWebSearch } from "./web-search";

/**
 * Resolve the thread/message provenance an artifact tool needs from the call
 * context. Returns an honest refusal (not a throw) when the call didn't come
 * from a chat turn — an artifact is owned by the thread/message that produced
 * it, so a background/sub-agent run has nowhere to attach one (ADR-0075).
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
      messageId: ctx.messageId,
    },
  };
}

export const systemTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "load_integration",
    riskTier: "no_risk",
    description:
      "Load another integration's tools for future turns when the workflow allowlist permits it.",
    inputSchema: loadIntegrationInput,
    execute: async (input, ctx) => {
      const allowed = ctx.allowedIntegrations ?? [];
      if (allowed.length > 0 && !allowed.includes(input.slug)) {
        return {
          ok: false,
          status: "not_allowed",
          slug: input.slug,
          reason: "workflow_allowed_integrations_cap",
        };
      }

      return { ok: true, slug: input.slug };
    },
  }),
  liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    description: "Spawn one focused sub-agent run with an isolated brief.",
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
    inputSchema: promoteScratchInput,
    execute: async (input, ctx) => {
      const from = parseScratchToolKey(input.fromKey);
      const to = parseScratchToolKey(input.toKey);
      if (from.zone !== "scratch" || to.zone !== "shared") {
        throw new Error(
          "system.promote requires fromKey=scratch.<subId>.<path> and toKey=shared.<path>",
        );
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
      "Search the live web and get back a short, cited answer. Use this for current events, facts you're unsure of, or anything outside your training data — do not guess from memory when a lookup would settle it. Returns a synthesized answer plus source URLs, not raw search results.",
    inputSchema: webSearchInput,
    execute: async (input, ctx) => {
      const { answer, citations } = await runWebSearch({
        query: input.query,
        userId: ctx.userId,
        runId: ctx.runId,
        stepId: ctx.stepId,
        idempotencyKey: ctx.toolCallId,
      });
      return { ok: true, query: input.query, answer, citations };
    },
  }),
  liveTool({
    integration: "system",
    action: "create_artifact",
    // Authors a synced artifact row for the user's own sidebar — no external
    // side effect, so it stays off the approvals path like other system tools.
    riskTier: "no_risk",
    description:
      "Produce a rich artifact the user reads in a side panel: a written `document` (markdown) or a deck/PDF of `pages` (HTML). Use this when the user asks you to write, draft, or build something substantial they'll want to read or present — a one-pager, a brief, a report, a slide deck, a PDF — instead of dumping it all into the chat reply. Opens the artifact; for a `document` author the whole markdown here, for `pages` follow with append_artifact_page per page. This is in-app content, not a downloadable file.",
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
      "Append one HTML page to a `pages` artifact created with create_artifact. Call once per page, in order; each page is self-contained HTML (inline all CSS, no external refs). Pages appear in the sidebar as you add them.",
    inputSchema: appendArtifactPageInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await appendArtifactPage(resolved.ctx, input);
    },
  }),
  liveTool({
    integration: "system",
    action: "update_artifact",
    riskTier: "no_risk",
    description:
      "Revise an existing artifact: rename it, replace a document's markdown, or replace a deck's full page list. Use this when the user asks for an edit to something you already produced this conversation.",
    inputSchema: updateArtifactInput,
    execute: async (input, ctx) => {
      const resolved = resolveArtifactContext(ctx);
      if (!resolved.ok) return resolved.result;
      return await updateArtifact(resolved.ctx, input);
    },
  }),
];
