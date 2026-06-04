import { INTEGRATION_SLUGS, isLoadableIntegrationSlug, todoSourceSchema } from "@alfred/contracts";
import { z } from "zod";
import { spawnSubAgent, spawnSubAgentInputSchema } from "../agent/sub-agents";
import { promoteScratch, readScratch, writeScratch } from "../scratchpad";
import { suggestTodo } from "../todos/suggest";
import { liveTool, type RegisteredTool } from "./registry";
import { parseScratchToolKey } from "./scratch-key";

const loadIntegrationInput = z
  .object({
    slug: z.enum(INTEGRATION_SLUGS).refine((slug) => slug !== "system", {
      message: "system is always loaded and cannot be loaded as an integration",
    }),
  })
  .strict();

const scratchKey = z.string().min(1).max(240);

const readScratchInput = z.object({ key: scratchKey }).strict();

const writeScratchInput = z
  .object({
    key: scratchKey,
    value: z.unknown(),
  })
  .strict();

const promoteScratchInput = z
  .object({
    fromKey: scratchKey,
    toKey: scratchKey,
  })
  .strict();

const suggestTodoInput = z
  .object({
    name: z.string().min(1).max(2_000).describe("Short imperative title for the commitment."),
    description: z
      .string()
      .max(20_000)
      .optional()
      .describe("Optional longer context for the todo."),
    assist: z
      .string()
      .max(20_000)
      .optional()
      .describe(
        "Optional tip on how to approach it. State honestly if you can't act on it (no permission / integration not connected). This is not execution.",
      ),
    sources: z
      .array(todoSourceSchema)
      .max(64)
      .optional()
      .describe(
        "Cross-source provenance: [{ provider, kind, id, url? }]. Include every channel this commitment spans so it dedups across surfaces.",
      ),
  })
  .strict();

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
];
