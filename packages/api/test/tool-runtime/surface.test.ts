import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { z } from "zod";

import {
  resolveToolSurface,
  restoreToolSurface,
  selectToolPreload,
  toolNamesForIntegrations,
} from "../../src/modules/tool-runtime";
import { liveTool, registerTools } from "../../src/modules/tools/registry";
import { resetToolFixtures } from "../lib/tool-fixtures";

beforeEach(resetToolFixtures);
afterEach(resetToolFixtures);

function registerSurfaceFixtures(): void {
  registerTools([
    liveTool({
      integration: "system",
      action: "search_tools",
      riskTier: "no_risk",
      availability: { surface: "kernel" },
      description: "Search tools.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "system",
      action: "read_chat_history",
      riskTier: "no_risk",
      availability: { surface: "kernel", requiresLiveChat: true },
      description: "Read chat history.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "gmail",
      action: "search",
      riskTier: "low",
      description: "Search Gmail.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
  ]);
}

test("restores a legacy surface through the registered tool catalog", () => {
  registerSurfaceFixtures();

  assert.deepEqual(
    restoreToolSurface({
      kind: "legacy",
      integrationNames: ["gmail", "system"],
      pendingNames: ["retired.tool"],
    }),
    ["gmail.search", "system.read_chat_history", "system.search_tools"],
  );
});

test("projects the exact caller-visible schemas and matching metrics", () => {
  registerSurfaceFixtures();

  const surface = resolveToolSurface({
    activeNames: ["gmail.search", "system.read_chat_history", "system.search_tools"],
    context: { caller: "boss", interaction: "background" },
  });

  assert.deepEqual(surface.surfacedNames, ["gmail.search", "system.search_tools"]);
  assert.deepEqual(surface.loadedNames, ["gmail.search"]);
  assert.deepEqual(Object.keys(surface.tools).sort(), surface.surfacedNames);
  assert.equal(surface.kernelCount, 1);
  assert.ok(surface.schemaBytes > 0);
  assert.ok(surface.schemaTokens > 0);
});

test("resets cached projections with the shared tool fixture lifecycle", () => {
  registerSurfaceFixtures();
  const first = resolveToolSurface({
    activeNames: ["gmail.search"],
    context: { caller: "boss", interaction: "live_chat" },
  });
  assert.equal(first.tools["gmail.search"]?.description, "Search Gmail.");

  resetToolFixtures();
  registerTools([
    liveTool({
      integration: "gmail",
      action: "search",
      riskTier: "low",
      description: "Search a different fixture.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
  ]);
  const second = resolveToolSurface({
    activeNames: ["gmail.search"],
    context: { caller: "boss", interaction: "live_chat" },
  });
  assert.equal(second.tools["gmail.search"]?.description, "Search a different fixture.");
});

test("lists integration tools without requiring a kernel", () => {
  registerTools([
    liveTool({
      integration: "gmail",
      action: "search",
      riskTier: "low",
      description: "Search Gmail.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
  ]);

  assert.deepEqual(toolNamesForIntegrations(["gmail", "system"]), ["gmail.search"]);
});

test("selects an exact available preload through the workflow allowlist", async () => {
  registerSurfaceFixtures();
  const availability = {
    integrations: new Map([["gmail", { health: "active" as const, accountLabel: null }]]),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };
  const transcript = [{ role: "user", content: "gmail.search" }];

  const allowed = await selectToolPreload({
    userId: "user_1",
    transcript,
    allowedIntegrations: ["gmail"],
    activeNames: ["system.search_tools"],
    context: { caller: "boss", interaction: "live_chat" },
    availability,
  });
  assert.equal(allowed.promptChars, transcript[0]?.content.length);
  assert.deepEqual(allowed.selectedNames, ["gmail.search"]);

  const disallowed = await selectToolPreload({
    userId: "user_1",
    transcript,
    allowedIntegrations: ["calendar"],
    activeNames: ["system.search_tools"],
    context: { caller: "boss", interaction: "live_chat" },
    availability,
  });
  assert.deepEqual(disallowed.selectedNames, []);
});
