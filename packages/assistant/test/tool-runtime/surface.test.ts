import type { TranscriptMessage } from "@alfred/ai";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { z } from "zod";
import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";

import {
  availableToolNamesByIntegration,
  resolveToolSurface,
  restoreToolSurface,
  selectToolPreload,
  toolNamesForIntegrations,
} from "@alfred/assistant/tool-runtime";
import { liveTool, registerTools } from "@alfred/assistant/tool-runtime";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";

beforeEach(resetToolFixtures);

afterEach(resetToolFixtures);

function registerSurfaceFixtures(): void {
  registerTools([
    liveTool({
      integration: "system",
      action: "search_tools",
      riskTier: "no_risk",
      replay: "safe",
      availability: { surface: "kernel" },
      description: "Search tools.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "system",
      action: "read_chat_history",
      riskTier: "no_risk",
      replay: "safe",
      availability: { surface: "kernel", requiresLiveChat: true },
      description: "Read chat history.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "contacts",
      action: "search",
      riskTier: "low",
      replay: "safe",
      description: "Search contacts.",
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
      integrationNames: ["contacts", "system"],
      pendingNames: ["retired.tool"],
    }),
    ["contacts.search", "system.read_chat_history", "system.search_tools"],
  );
});

test("projects the exact caller-visible schemas and matching metrics", () => {
  registerSurfaceFixtures();

  const surface = resolveToolSurface({
    activeNames: ["contacts.search", "system.read_chat_history", "system.search_tools"],
    context: { caller: "boss", interaction: "background" },
  });

  assert.deepEqual(surface.surfacedNames, ["contacts.search", "system.search_tools"]);
  assert.deepEqual(surface.loadedNames, ["contacts.search"]);
  assert.deepEqual(Object.keys(surface.tools).toSorted(), surface.surfacedNames);
  assert.equal(surface.kernelCount, 1);
  assert.ok(surface.schemaBytes > 0);
  assert.ok(surface.schemaTokens > 0);
});

test("resets cached projections with the shared tool fixture lifecycle", () => {
  registerSurfaceFixtures();

  const first = resolveToolSurface({
    activeNames: ["contacts.search"],
    context: { caller: "boss", interaction: "live_chat" },
  });

  assert.equal(first.tools["contacts.search"]?.description, "Search contacts.");

  resetToolFixtures();
  registerTools([
    liveTool({
      integration: "contacts",
      action: "search",
      riskTier: "low",
      replay: "safe",
      description: "Search a different fixture.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
  ]);

  const second = resolveToolSurface({
    activeNames: ["contacts.search"],
    context: { caller: "boss", interaction: "live_chat" },
  });

  assert.equal(second.tools["contacts.search"]?.description, "Search a different fixture.");
});

test("lists integration tools without requiring a kernel", () => {
  registerTools([
    liveTool({
      integration: "contacts",
      action: "search",
      riskTier: "low",
      replay: "safe",
      description: "Search contacts.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
  ]);

  assert.deepEqual(toolNamesForIntegrations(["contacts", "system"]), ["contacts.search"]);
});

test("groups available tool names by integration, sorted, honoring the allowlist", () => {
  registerTools([
    // Register search before get so a lost sort reorders the output.
    liveTool({
      integration: "contacts",
      action: "search",
      riskTier: "low",
      replay: "safe",
      description: "Search contacts.",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "contacts",
      action: "get",
      riskTier: "low",
      replay: "safe",
      description: "Read a contact.",
      inputSchema: z.object({ id: z.string() }).strict(),
      execute: async () => ({}),
    }),
    liveTool({
      integration: "vercel",
      action: "list_projects",
      riskTier: "low",
      replay: "safe",
      description: "List Vercel projects.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  ]);

  const availability: IntegrationAvailabilitySnapshot = {
    integrations: new Map([
      ["contacts", { health: "active" as const, accountLabel: null }],
      ["vercel", { health: "active" as const, accountLabel: null }],
      ["calendar", { health: "needs_reauth" as const, accountLabel: null }],
    ]),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };

  const context = { caller: "boss" as const, interaction: "live_chat" as const };

  const grouped = availableToolNamesByIntegration({
    availability,
    allowedIntegrations: ["contacts", "vercel"],
    context,
  });

  assert.deepEqual(grouped.get("contacts"), ["contacts.get", "contacts.search"]);
  assert.deepEqual(grouped.get("vercel"), ["vercel.list_projects"]);

  // The allowlist removes Vercel even though its credentials are healthy.
  const contactsOnly = availableToolNamesByIntegration({
    availability,
    allowedIntegrations: ["contacts"],
    context,
  });

  assert.deepEqual(contactsOnly.get("contacts"), ["contacts.get", "contacts.search"]);
  assert.equal(contactsOnly.has("vercel"), false);
});

test("selects an exact available preload through the workflow allowlist", async () => {
  registerSurfaceFixtures();

  const availability: IntegrationAvailabilitySnapshot = {
    integrations: new Map([["contacts", { health: "active" as const, accountLabel: null }]]),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };

  const transcript: TranscriptMessage[] = [{ role: "user", content: "contacts.search" }];

  const allowed = await selectToolPreload({
    userId: "user_1",
    transcript,
    allowedIntegrations: ["contacts"],
    activeNames: ["system.search_tools"],
    context: { caller: "boss", interaction: "live_chat" },
    availability,
  });

  assert.equal(allowed.promptChars, transcript[0]?.content.length);
  assert.deepEqual(allowed.selectedNames, ["contacts.search"]);

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
