import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { z } from "zod";

import {
  normalizeCapabilitySurface,
  prepareCapabilityPreload,
  resolveCapabilitySurface,
} from "../../src/modules/capabilities";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTools,
} from "../../src/modules/tools/registry";
import { registerToolCapabilitySurfaceAdapter } from "../../src/modules/tools/capability-surface";

afterEach(() => clearToolRegistryForTests());

function registerSurfaceFixtures(): void {
  registerToolCapabilitySurfaceAdapter();
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
      availability: { surface: "kernel", requiresThread: true },
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

test("normalizes a legacy surface through the registered capability catalog", () => {
  registerSurfaceFixtures();

  assert.deepEqual(
    normalizeCapabilitySurface({
      legacyIntegrationNames: ["gmail", "system"],
      pendingNames: ["retired.tool"],
    }),
    {
      activeNames: ["gmail.search", "system.read_chat_history", "system.search_tools"],
      kernelNames: ["system.read_chat_history", "system.search_tools"],
    },
  );
});

test("projects the exact caller-visible schemas and matching metrics", () => {
  registerSurfaceFixtures();

  const surface = resolveCapabilitySurface({
    activeNames: ["gmail.search", "system.read_chat_history", "system.search_tools"],
    context: { caller: "boss", hasThread: false },
  });

  assert.deepEqual(surface.surfacedNames, ["gmail.search", "system.search_tools"]);
  assert.deepEqual(Object.keys(surface.tools).sort(), surface.surfacedNames);
  assert.equal(surface.kernelCount, 1);
  assert.ok(surface.schemaBytes > 0);
  assert.ok(surface.schemaTokens > 0);
});

test("selects an exact available preload through the workflow allowlist", async () => {
  registerSurfaceFixtures();
  const availability = {
    integrations: new Map([["gmail", { health: "active" as const, accountLabel: null }]]),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };
  const transcript = [{ role: "user", content: "gmail.search" }];

  const allowed = prepareCapabilityPreload({
    userId: "user_1",
    transcript,
    allowedIntegrations: ["gmail"],
    activeNames: ["system.search_tools"],
    context: { caller: "boss", hasThread: true },
    availability,
  });
  assert.equal(allowed.promptChars, transcript[0]?.content.length);
  assert.deepEqual(await allowed.select(), ["gmail.search"]);

  const disallowed = prepareCapabilityPreload({
    userId: "user_1",
    transcript,
    allowedIntegrations: ["calendar"],
    activeNames: ["system.search_tools"],
    context: { caller: "boss", hasThread: true },
    availability,
  });
  assert.deepEqual(await disallowed.select(), []);
});
