import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { z } from "zod";

import { systemToolKernel } from "../../src/modules/agent/tool-surface";
import { estimateToolSurfaceBudget, toolSchemaSize } from "../../src/modules/agent/schema-budget";
import {
  getTool,
  listRegisteredTools,
  type RegisteredTool,
} from "../../src/modules/tools/registry";
import { registerBuiltinTools } from "../../src/modules/tools";

/**
 * Schema-budget regression guard (#414, PRD User Story 15). The whole point of
 * lazy loading is that the model sees a *tiny* kernel by default and only pays
 * for tools it loads. These ceilings pin that guarantee against the real tool
 * registry: a giant schema slipping into the kernel, or an integration doubling
 * its surface, trips a ceiling here instead of silently inflating every prompt.
 *
 * Ceilings sit ~30-40% above the measured surface so ordinary description edits
 * pass, but adding a whole tool to the kernel (the smallest bad regression, ~2KB)
 * or a large new integration to the full surface fails. When a ceiling legitimately
 * needs to rise, bump it deliberately — the bump is the review signal.
 */

// Measured 2026-07-16: kernel 5,900 B; full 51,037 B across 57 tools.
const KERNEL_SCHEMA_BYTES_CEILING = 8_000;
const KERNEL_SCHEMA_TOKENS_CEILING = 2_000;
const FULL_SCHEMA_BYTES_CEILING = 68_000;

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
      toolsByName([
        ...systemToolKernel(),
        "calendar.list_events" as ToolName,
        "gmail.search" as ToolName,
      ]),
    );
    const loaded = estimateToolSurfaceBudget(
      toolsByName([
        ...systemToolKernel(),
        "calendar.list_events" as ToolName,
        "gmail.search" as ToolName,
        "github.search" as ToolName,
      ]),
    );
    const full = estimateToolSurfaceBudget([...listRegisteredTools()]);

    // The lazy-tool win: each exact activation pays only for its own schema,
    // while the kernel remains a small fraction of the everything-loaded surface.
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
    const tool = getTool("system.web_search" as ToolName);
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
      inputSchema: sharedSchema,
    });
    const verbose = toolSchemaSize({
      name: "github.search",
      description: "Search repositories, issues, and pull requests across GitHub",
      inputSchema: sharedSchema,
    });

    assert.ok(verbose.bytes > compact.bytes);
    assert.ok(verbose.tokens > compact.tokens);
  });

  test("reports UTF-8 bytes separately from character-based token estimates", () => {
    const ascii = toolSchemaSize({
      name: "gmail.search",
      description: "Search mail - quickly",
      inputSchema: z.object({}),
    });
    const unicode = toolSchemaSize({
      name: "gmail.search",
      description: "Search mail — quickly",
      inputSchema: z.object({}),
    });

    assert.equal(unicode.tokens, ascii.tokens);
    assert.ok(unicode.bytes > ascii.bytes);
  });
});
