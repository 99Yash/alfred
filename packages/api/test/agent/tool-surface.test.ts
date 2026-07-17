import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { z } from "zod";

import {
  applyExactToolLoad,
  migrateRecordedToolNames,
  systemToolKernel,
} from "../../src/modules/agent/tool-surface";
import { currentTimeSnapshot } from "../../src/modules/tools/system";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTools,
} from "../../src/modules/tools/registry";

afterEach(() => clearToolRegistryForTests());

test("the default system kernel excludes loadable system capabilities", () => {
  registerTools([
    liveTool({
      integration: "system",
      action: "search_tools",
      riskTier: "no_risk",
      availability: { surface: "kernel" },
      description: "Search tools.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "system",
      action: "load_tool",
      riskTier: "no_risk",
      availability: { surface: "kernel" },
      description: "Load a tool.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "system",
      action: "current_time",
      riskTier: "no_risk",
      availability: { surface: "kernel" },
      description: "Read the current time.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "system",
      action: "fetch_url",
      riskTier: "no_risk",
      description: "Fetch a URL.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  ]);

  assert.deepEqual(systemToolKernel(), [
    "system.current_time",
    "system.load_tool",
    "system.search_tools",
  ]);
});

test("the system kernel fails loudly when no kernel tools are registered", () => {
  assert.throws(() => systemToolKernel(), /No system tools are registered for the kernel surface/);
});

test("a hidden system capability becomes active only after exact load", () => {
  registerTools([
    liveTool({
      integration: "system",
      action: "fetch_url",
      riskTier: "no_risk",
      description: "Fetch a URL.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  ]);

  assert.deepEqual(applyExactToolLoad([], { ok: false, name: "system.fetch_url" }), []);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "system.fetch_url" }), [
    "system.fetch_url",
  ]);
});

test("persisted preload attribution is narrowed without seeding the kernel", () => {
  registerTools([
    liveTool({
      integration: "system",
      action: "fetch_url",
      riskTier: "no_risk",
      description: "Fetch a URL.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  ]);

  assert.deepEqual(
    migrateRecordedToolNames(["system.fetch_url", "retired.tool", "system.fetch_url"]),
    ["system.fetch_url"],
  );
  assert.deepEqual(migrateRecordedToolNames([]), []);
});

test("current time reports a deterministic local snapshot", () => {
  assert.deepEqual(currentTimeSnapshot("Asia/Kolkata", new Date("2026-07-15T18:45:30.000Z")), {
    isoTime: "2026-07-15T18:45:30.000Z",
    localDate: "2026-07-16",
    localTime: "00:15:30",
    weekday: "Thursday",
    timezone: "Asia/Kolkata",
    utcOffset: "+05:30",
  });
});
