import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { z } from "zod";

import { systemToolKernel } from "../../src/modules/agent/tool-surface";
import {
  capabilitySchemaSize,
  estimateCapabilitySurfaceBudget,
} from "../../src/modules/tools/schema-budget";
import {
  getTool,
  listRegisteredTools,
  type RegisteredTool,
} from "../../src/modules/tools/registry";
import { registerBuiltinTools } from "../../src/modules/tools/runtime";

/**
 * Schema-budget regression guard (#414, PRD User Story 15). The whole point of
 * lazy loading is that the model sees a *tiny* kernel by default and only pays
 * for tools it loads. These ceilings pin that guarantee against the real tool
 * registry: a giant schema slipping into the kernel, or an integration doubling
 * its surface, trips a ceiling here instead of silently inflating every prompt.
 *
 * The kernel ceiling is a *tight* ratchet: the kernel schema is paid on every
 * single prompt, so it sits only ~10-15% above the measured surface — enough for
 * ordinary description edits, but a new tool declared `surface:"kernel"` (even a
 * medium ~1KB one, well under the old 8KB ceiling) trips it. The full-surface
 * ceiling keeps a looser ~30% margin since it is only paid when everything loads.
 * When a ceiling legitimately needs to rise, bump it deliberately — the bump is
 * the review signal.
 */

// Measured 2026-07-16: kernel 5,904 B / 1,477 tok across 8 tools; full 51,127 B across 57 tools.
// Measured 2026-07-20: full 71,764 B — the general invocation tier (ADR-0074) added one
// read-only `.request` passthrough tool per supported integration (railway.graphql + the REST
// family github/notion/vercel + the six Google products), each carrying a query-DSL-steering
// description. These are lazy (never kernel), so the growth is only paid when everything loads.
// Measured 2026-08-01: full 80,532 B — workflow recovery added one small lazy tool that
// revalidates a blocked immutable draft before the existing high-risk activation tool runs.
const KERNEL_SCHEMA_BYTES_CEILING = 6_600;
const KERNEL_SCHEMA_TOKENS_CEILING = 1_700;
const FULL_SCHEMA_BYTES_CEILING = 81_000;

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
    const budget = estimateCapabilitySurfaceBudget(toolsByName(systemToolKernel()));
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
    const kernel = estimateCapabilitySurfaceBudget(toolsByName(systemToolKernel()));
    const preloaded = estimateCapabilitySurfaceBudget(
      toolsByName([
        ...systemToolKernel(),
        "calendar.list_events" as ToolName,
        "gmail.search" as ToolName,
      ]),
    );
    const loaded = estimateCapabilitySurfaceBudget(
      toolsByName([
        ...systemToolKernel(),
        "calendar.list_events" as ToolName,
        "gmail.search" as ToolName,
        "github.search" as ToolName,
      ]),
    );
    const full = estimateCapabilitySurfaceBudget([...listRegisteredTools()]);

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
    const budget = estimateCapabilitySurfaceBudget([...listRegisteredTools()]);
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
    const first = capabilitySchemaSize(tool);
    const second = capabilitySchemaSize(tool);
    assert.deepEqual(first, second);
    assert.ok(first.bytes > 0);
    assert.ok(first.tokens > 0);
  });

  test("tools sharing one schema keep distinct name/description sizes", () => {
    const sharedSchema = z.object({ query: z.string() });
    const compact = capabilitySchemaSize({
      name: "gmail.search",
      description: "Search mail",
      inputSchema: sharedSchema,
    });
    const verbose = capabilitySchemaSize({
      name: "github.search",
      description: "Search repositories, issues, and pull requests across GitHub",
      inputSchema: sharedSchema,
    });

    assert.ok(verbose.bytes > compact.bytes);
    assert.ok(verbose.tokens > compact.tokens);
  });

  test("reports UTF-8 bytes separately from character-based token estimates", () => {
    const ascii = capabilitySchemaSize({
      name: "gmail.search",
      description: "Search mail - quickly",
      inputSchema: z.object({}),
    });
    const unicode = capabilitySchemaSize({
      name: "gmail.search",
      description: "Search mail — quickly",
      inputSchema: z.object({}),
    });

    assert.equal(unicode.tokens, ascii.tokens);
    assert.ok(unicode.bytes > ascii.bytes);
  });
});
