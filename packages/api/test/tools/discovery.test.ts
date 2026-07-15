import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LoadableIntegrationSlug } from "@alfred/contracts";
import { z } from "zod";

import { applyExactToolLoad } from "../../src/modules/agent/tool-surface";
import {
  preloadToolCatalog,
  searchToolCatalog,
  type ToolCatalogAccess,
} from "../../src/modules/tools/discovery";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
  type RegisteredTool,
} from "../../src/modules/tools/registry";

afterEach(() => clearToolRegistryForTests());

const gmailSearch = liveTool({
  integration: "gmail",
  action: "search",
  riskTier: "no_risk",
  description: "Search mail messages.",
  discovery: {
    title: "Search email",
    summary: "Find messages in the inbox.",
    aliases: ["find mail"],
    tags: ["communication"],
    entities: ["message"],
    verbs: ["search"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const calendarCreate = liveTool({
  integration: "calendar",
  action: "create_event",
  riskTier: "medium",
  description: "Create a calendar event.",
  discovery: {
    title: "Create event",
    summary: "Schedule a new meeting.",
    aliases: ["book meeting"],
    tags: ["calendar"],
    entities: ["meeting"],
    verbs: ["schedule"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const calendarList = liveTool({
  integration: "calendar",
  action: "list_events",
  riskTier: "no_risk",
  description: "List calendar events.",
  discovery: {
    title: "List events",
    summary: "Show upcoming calendar events.",
    aliases: ["what's on my calendar"],
    tags: ["calendar"],
    entities: ["calendar", "event", "meeting"],
    verbs: ["list", "show", "read"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const tools: readonly RegisteredTool[] = [gmailSearch, calendarCreate];

function access(
  available: readonly LoadableIntegrationSlug[],
  allowedIntegrations: readonly string[] = [],
): ToolCatalogAccess {
  return { availableIntegrations: new Set(available), allowedIntegrations };
}

describe("tool discovery", () => {
  test("ranks exact canonical names first", () => {
    const found = searchToolCatalog({
      query: "gmail.search",
      tools,
      access: access(["gmail", "calendar"]),
    });
    assert.equal(found[0]?.name, "gmail.search");
    assert.equal(found[0]?.reason, "exact tool name");
    assert.equal("inputSchema" in (found[0] ?? {}), false, "search must not expose schemas");
  });

  test("matches aliases", () => {
    const found = searchToolCatalog({
      query: "find mail",
      tools,
      access: access(["gmail"]),
    });
    assert.equal(found[0]?.name, "gmail.search");
    assert.match(found[0]?.reason ?? "", /alias/);
  });

  test("matches tags, entities, and verbs", () => {
    const catalogAccess = access(["gmail", "calendar"]);
    assert.equal(
      searchToolCatalog({ query: "communication", tools, access: catalogAccess })[0]?.name,
      "gmail.search",
    );
    assert.equal(
      searchToolCatalog({ query: "message", tools, access: catalogAccess })[0]?.name,
      "gmail.search",
    );
    assert.equal(
      searchToolCatalog({ query: "schedule", tools, access: catalogAccess })[0]?.name,
      "calendar.create_event",
    );
  });

  test("omits tools whose integration is unavailable", () => {
    const found = searchToolCatalog({ query: "find mail", tools, access: access(["calendar"]) });
    assert.deepEqual(found, []);
  });

  test("omits tools outside the workflow allowlist", () => {
    const found = searchToolCatalog({
      query: "find mail",
      tools,
      access: access(["gmail", "calendar"], ["calendar"]),
    });
    assert.deepEqual(found, []);
  });

  test("deterministically preloads likely exact tools and skips active ones", () => {
    const args = {
      prompt: "Please schedule a meeting tomorrow",
      tools,
      access: access(["gmail", "calendar"]),
    } as const;
    assert.deepEqual(preloadToolCatalog({ ...args, activeTools: [] }), ["calendar.create_event"]);
    assert.deepEqual(preloadToolCatalog({ ...args, activeTools: ["calendar.create_event"] }), []);
  });

  test("preloads intent matches without activating a sibling write from a generic noun", () => {
    const args = {
      tools: [calendarList, calendarCreate],
      access: access(["calendar"]),
      activeTools: [],
    } as const;
    assert.deepEqual(preloadToolCatalog({ ...args, prompt: "What's on my calendar Friday?" }), [
      "calendar.list_events",
    ]);
    assert.deepEqual(preloadToolCatalog({ ...args, prompt: "calendar Friday" }), []);
  });
});

test("exact load result activates only the registered chosen tool", () => {
  registerTool(gmailSearch);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "gmail.search" }), ["gmail.search"]);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "calendar.create_event" }), []);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "not.real" }), []);
});
