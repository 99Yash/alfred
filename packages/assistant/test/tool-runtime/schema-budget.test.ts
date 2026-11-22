import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { CODE_RUN_TOOL, type ToolName, type ToolRunContext } from "@alfred/contracts";
import { z } from "zod";

import { systemToolKernel } from "@alfred/assistant/execution/tool-surface";
import {
  estimateToolSurfaceBudget,
  toolSchemaSize,
} from "@alfred/assistant/tool-runtime/schema-budget";
import {
  codeRunIndexPaths,
  resolveToolSurface,
  type RegisteredTool,
} from "@alfred/assistant/tool-runtime";
import { registerToolsRuntimeAdapter } from "@alfred/assistant/tool-runtime/surface-adapter";
import { getTool, listRegisteredTools } from "../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../src/tool-runtime/builtin-tools";

/**
 * Ceilings on tool-schema size. The kernel is paid on every prompt, so its
 * ceiling sits about 10% above the measurement. Each read path gets its own ceiling. The full-surface ceiling sits
 * about one small tool above it. Raise a ceiling on purpose: the bump is the review signal.
 */

// Measured 2026-10-12: kernel 12,386 B / ~3,097 tok across 10 tools; full 89,881 B across 72 tools.
// 2026-11-21: kernel 12,800 B / ~3,201 tok across 10 tools, with the short system.current_time
// text (275 B).
const KERNEL_SCHEMA_BYTES_CEILING = 13_000;

const KERNEL_SCHEMA_TOKENS_CEILING = 3_300;

// The minimum first step of a Code Mode chat: the kernel plus `system.code_run`, through the same
// projection that the chat surface uses (`resolveToolSurface`), so the reads that run only in a
// script drop out. Code Mode is the default chat read path (ADR-0124). A preload or a carried tool
// adds to it, so a real first step can be larger. The index is the one that a user with no
// connection pins: only the system reads (ADR-0130 decision 6, #1806).
// Measured 2026-11-21: 24,153 B / ~6,038 tok across 7 tools; system.code_run alone is 17,863 B.
// 2026-11-22 (#1806): 16,073 B / ~4,019 tok with the pinned index; the full index is 24,399 B.
const CODE_RUN_FIRST_STEP_BYTES_CEILING = 17_700;

/** The context of a Code Mode chat turn (`chat-turn.ts` `chatToolRunIdentity`). */
const CODE_RUN_CHAT_CONTEXT = {
  caller: "boss",
  interaction: "live_chat",
  readPath: "code_run",
} as const satisfies ToolRunContext;

// Tools load lazily through system.load_tool, so only the kernel ceiling bounds the bytes
// that one prompt carries. This ceiling only catches a schema that grows by mistake.
// 2026-10-23: full 100,460 B after gmail.modify_message (Google REST parity, one tool per slice).
// 2026-10-23: full 98,428 B after Notion went MCP-only (-5 tools) and contacts.* (+3 tools).
const FULL_SCHEMA_BYTES_CEILING = 102_000;

/** The artifact/search giants must never bootstrap the kernel. */
const NON_KERNEL_GIANTS: readonly ToolName[] = [
  "system.create_artifact",
  "system.append_artifact_page",
  "system.update_artifact",
];

function toolsByName(names: readonly ToolName[]): RegisteredTool[] {
  return names.map((name) => {
    const tool = getTool(name);
    assert.ok(tool, `${name} should be registered for this budget scenario`);

    return tool;
  });
}

describe("tool-schema budget", () => {
  before(() => {
    registerBuiltinTools();
    registerToolsRuntimeAdapter();
  });

  test("the kernel surface stays within its byte and token budget", () => {
    const budget = estimateToolSurfaceBudget(toolsByName(systemToolKernel()));
    assert.ok(
      budget.schemaBytes <= KERNEL_SCHEMA_BYTES_CEILING,
      `kernel schema is ${budget.schemaBytes} B, over the ${KERNEL_SCHEMA_BYTES_CEILING} B ceiling`,
    );
    assert.ok(
      budget.schemaTokens <= KERNEL_SCHEMA_TOKENS_CEILING,
      `kernel schema is ~${budget.schemaTokens} tok, over the ${KERNEL_SCHEMA_TOKENS_CEILING} tok ceiling`,
    );
  });

  test("the minimum first step of a Code Mode chat stays within its byte budget", () => {
    const systemReads = listRegisteredTools()
      .filter((tool) => tool.codeModeRead && tool.integration === "system")
      .map((tool) => tool.name);

    const surface = resolveToolSurface({
      activeNames: [...systemToolKernel(), CODE_RUN_TOOL],
      context: CODE_RUN_CHAT_CONTEXT,
      codeRunIndex: codeRunIndexPaths(systemReads),
    });

    assert.ok(surface.surfacedNames.includes(CODE_RUN_TOOL));
    assert.ok(
      surface.schemaBytes <= CODE_RUN_FIRST_STEP_BYTES_CEILING,
      `the minimum Code Mode first step is ${surface.schemaBytes} B, over the ${CODE_RUN_FIRST_STEP_BYTES_CEILING} B ceiling`,
    );
  });

  test("kernel, preloaded, and subsequently loaded surfaces grow predictably", () => {
    const kernel = estimateToolSurfaceBudget(toolsByName(systemToolKernel()));

    const preloaded = estimateToolSurfaceBudget(
      toolsByName([...systemToolKernel(), "contacts.list", "contacts.search"]),
    );

    const loaded = estimateToolSurfaceBudget(
      toolsByName([
        ...systemToolKernel(),
        "contacts.list",
        "contacts.search",
        "sheets.append_values",
      ]),
    );

    const full = estimateToolSurfaceBudget([...listRegisteredTools()]);

    assert.ok(kernel.schemaBytes < preloaded.schemaBytes);
    assert.ok(preloaded.schemaBytes < loaded.schemaBytes);
    assert.ok(loaded.schemaBytes < full.schemaBytes);
    assert.ok(
      kernel.schemaBytes * 3 < full.schemaBytes,
      `kernel (${kernel.schemaBytes} B) is not a small fraction of full (${full.schemaBytes} B)`,
    );
  });

  test("the full surface stays within its byte budget", () => {
    const budget = estimateToolSurfaceBudget([...listRegisteredTools()]);
    assert.ok(
      budget.schemaBytes <= FULL_SCHEMA_BYTES_CEILING,
      `full schema is ${budget.schemaBytes} B, over the ${FULL_SCHEMA_BYTES_CEILING} B ceiling`,
    );
  });

  test("the large artifact/search schemas are never in the kernel", () => {
    const kernel = new Set(systemToolKernel());

    for (const giant of NON_KERNEL_GIANTS) {
      assert.ok(!kernel.has(giant), `${giant} must stay lazy, not bootstrap the kernel`);
    }
  });

  test("per-tool sizes are deterministic and memoized to a stable value", () => {
    const tool = getTool("system.web_search");
    assert.ok(tool, "system.web_search should be registered");

    const first = toolSchemaSize(tool);
    const second = toolSchemaSize(tool);
    assert.deepEqual(first, second);
    assert.ok(first.bytes > 0);
    assert.ok(first.tokens > 0);
  });

  test("tools sharing one schema keep distinct name/description sizes", () => {
    const sharedSchema = z.object({ query: z.string() });

    const compact = toolSchemaSize({
      name: "contacts.search",
      description: "Search contacts",
      modelInputSchema: sharedSchema,
    });

    const verbose = toolSchemaSize({
      name: "contacts.list",
      description: "List saved contacts and the people the user emailed across Google Contacts",
      modelInputSchema: sharedSchema,
    });

    assert.ok(verbose.bytes > compact.bytes);
    assert.ok(verbose.tokens > compact.tokens);
  });

  test("reports UTF-8 bytes separately from character-based token estimates", () => {
    const ascii = toolSchemaSize({
      name: "contacts.search",
      description: "Search contacts - quickly",
      modelInputSchema: z.object({}),
    });

    const unicode = toolSchemaSize({
      name: "contacts.search",
      description: "Search contacts — quickly",
      modelInputSchema: z.object({}),
    });

    assert.equal(unicode.tokens, ascii.tokens);
    assert.ok(unicode.bytes > ascii.bytes);
  });
});
