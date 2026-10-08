import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { z } from "zod";

import { systemToolKernel } from "@alfred/assistant/execution/tool-surface";
import {
  estimateToolSurfaceBudget,
  toolSchemaSize,
} from "@alfred/assistant/tool-runtime/schema-budget";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { getTool, listRegisteredTools } from "../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../src/tool-runtime/builtin-tools";

/**
 * Ceilings on tool-schema size. The kernel is paid on every prompt, so its
 * ceiling sits about 10% above the measurement. The full-surface ceiling sits
 * about one small tool above it. Raise a ceiling on purpose: the bump is the review signal.
 */

// Measured 2026-10-08: kernel 12,083 B / ~3,021 tok across 10 tools; full 89,578 B across 72 tools.
const KERNEL_SCHEMA_BYTES_CEILING = 13_000;

const KERNEL_SCHEMA_TOKENS_CEILING = 3_300;

const FULL_SCHEMA_BYTES_CEILING = 95_000;

/** The artifact/search giants must never bootstrap the kernel. */
const NON_KERNEL_GIANTS: readonly ToolName[] = [
  "system.create_artifact",
  "system.append_artifact_page",
  "github.search",
];

function toolsByName(names: readonly ToolName[]): RegisteredTool[] {
  return names.map((name) => {
    const tool = getTool(name);
    assert.ok(tool, `${name} should be registered for this budget scenario`);

    return tool;
  });
}

describe("tool-schema budget", () => {
  before(() => registerBuiltinTools());

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

  test("kernel, preloaded, and subsequently loaded surfaces grow predictably", () => {
    const kernel = estimateToolSurfaceBudget(toolsByName(systemToolKernel()));

    const preloaded = estimateToolSurfaceBudget(
      toolsByName([...systemToolKernel(), "calendar.list_events", "gmail.search"]),
    );

    const loaded = estimateToolSurfaceBudget(
      toolsByName([...systemToolKernel(), "calendar.list_events", "gmail.search", "github.search"]),
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

    if (!tool) return;
    const first = toolSchemaSize(tool);
    const second = toolSchemaSize(tool);
    assert.deepEqual(first, second);
    assert.ok(first.bytes > 0);
    assert.ok(first.tokens > 0);
  });

  test("tools sharing one schema keep distinct name/description sizes", () => {
    const sharedSchema = z.object({ query: z.string() });

    const compact = toolSchemaSize({
      name: "gmail.search",
      description: "Search mail",
      modelInputSchema: sharedSchema,
    });

    const verbose = toolSchemaSize({
      name: "github.search",
      description: "Search repositories, issues, and pull requests across GitHub",
      modelInputSchema: sharedSchema,
    });

    assert.ok(verbose.bytes > compact.bytes);
    assert.ok(verbose.tokens > compact.tokens);
  });

  test("reports UTF-8 bytes separately from character-based token estimates", () => {
    const ascii = toolSchemaSize({
      name: "gmail.search",
      description: "Search mail - quickly",
      modelInputSchema: z.object({}),
    });

    const unicode = toolSchemaSize({
      name: "gmail.search",
      description: "Search mail — quickly",
      modelInputSchema: z.object({}),
    });

    assert.equal(unicode.tokens, ascii.tokens);
    assert.ok(unicode.bytes > ascii.bytes);
  });
});
