import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LoadableIntegrationSlug, ToolName } from "@alfred/contracts";
import { z } from "zod";

import { applyExactToolLoad } from "../../src/modules/agent/tool-surface";
import {
  preloadToolCatalog,
  resolveExactToolLoad,
  searchToolCatalog,
  type ToolCatalogAccess,
} from "../../src/modules/tools/discovery";
import {
  availableToolNames,
  evaluateToolAvailability,
  type IntegrationAvailabilitySnapshot,
  type ToolAvailabilityResult,
} from "../../src/modules/integrations/availability";
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
    aliases: ["find mail", "common task"],
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
    aliases: ["book meeting", "common task"],
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
    aliases: ["what's on my calendar", "common task"],
    tags: ["calendar"],
    entities: ["calendar", "event", "meeting"],
    verbs: ["list", "show", "read"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const gmailRead = liveTool({
  integration: "gmail",
  action: "read_message",
  riskTier: "low",
  description: "Read mail messages.",
  discovery: { aliases: ["mail task", "common task"], entities: ["mail"], verbs: ["handle"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const gmailSend = liveTool({
  integration: "gmail",
  action: "send_draft",
  riskTier: "high",
  description: "Send mail messages.",
  discovery: { aliases: ["mail task", "common task"], entities: ["mail"], verbs: ["handle"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const systemFetch = liveTool({
  integration: "system",
  action: "fetch_url",
  riskTier: "no_risk",
  description: "Read a known web page.",
  discovery: { aliases: ["read webpage"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const tools: readonly RegisteredTool[] = [gmailSearch, calendarCreate];

function access(
  available: readonly LoadableIntegrationSlug[],
  allowedIntegrations: readonly string[] = [],
): ToolCatalogAccess {
  const availableSet = new Set(available);
  const allowed = new Set(allowedIntegrations);
  const availability = new Map<ToolName, ToolAvailabilityResult>();
  for (const tool of [gmailSearch, gmailRead, gmailSend, calendarCreate, calendarList]) {
    // Mirror evaluateToolCatalog's precedence: the allowlist is decided first
    // and surfaces as a `not_allowed` result, so the map is the single source
    // of both availability and reason (no parallel allowlist predicate).
    availability.set(
      tool.name,
      allowed.size > 0 && !allowed.has(tool.integration)
        ? {
            available: false,
            code: "not_allowed",
            reason: "Outside this workflow's integration allowlist.",
          }
        : availableSet.has(tool.integration as LoadableIntegrationSlug)
          ? { available: true }
          : {
              available: false,
              code: "not_connected",
              reason: `${tool.integration} is not connected.`,
            },
    );
  }
  return { allowedIntegrations, availability };
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

  test("discovers and exactly loads a non-kernel system capability", async () => {
    registerTool(systemFetch);
    const found = searchToolCatalog({
      query: "read webpage",
      tools: [systemFetch],
      access: {
        allowedIntegrations: [],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [systemFetch.name, { available: true }],
        ]),
      },
    });
    assert.equal(found[0]?.name, "system.fetch_url");

    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "system.fetch_url",
        allowedIntegrations: [],
        context: { caller: "boss", hasThread: true },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      { ok: true, name: "system.fetch_url" },
    );
  });

  test("exact load returns the specific unavailability code and reason, not a generic string", async () => {
    registerTool(notionCreate);
    // The credential-health snapshot has no Notion provider, so the shared
    // evaluator returns not_connected — and the load path hands that exact
    // reason to the model instead of "not available in this run's context".
    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "notion.create_page",
        allowedIntegrations: [],
        context: { caller: "boss", hasThread: true },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      { ok: false, status: "not_connected", reason: "Notion is not connected." },
    );
  });

  test("exact load reports the allowlist as not_allowed", async () => {
    registerTool(notionCreate);
    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "notion.create_page",
        allowedIntegrations: ["gmail"],
        context: { caller: "boss", hasThread: true },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      {
        ok: false,
        status: "not_allowed",
        reason: "Outside this workflow's integration allowlist.",
      },
    );
  });

  test("exact load rejects an unregistered name as unknown_tool", async () => {
    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "notion.nope",
        allowedIntegrations: [],
        context: { caller: "boss", hasThread: true },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      { ok: false, status: "unknown_tool", reason: "Tool 'notion.nope' is not registered." },
    );
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

  test("applies the preload limit after removing already-active candidates", () => {
    const ranked = [calendarCreate, calendarList, gmailRead, gmailSearch, gmailSend];
    const activeTools = ranked.slice(0, 4).map((tool) => tool.name);
    assert.deepEqual(
      preloadToolCatalog({
        prompt: "common task",
        limit: 4,
        tools: ranked,
        activeTools,
        access: {
          allowedIntegrations: [],
          availability: new Map<ToolName, ToolAvailabilityResult>(
            ranked.map((tool) => [tool.name, { available: true }]),
          ),
        },
      }),
      ["gmail.send_draft"],
    );
  });
});

test("exact availability respects tool scopes and caller context", () => {
  const readonlyScope = "gmail.readonly";
  const read = liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description: "Search mail.",
    availability: { credential: { provider: "google", anyOfScopes: [readonlyScope] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const send = liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    description: "Send mail.",
    availability: { credential: { provider: "google", anyOfScopes: ["gmail.send"] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const spawn = liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    description: "Spawn child.",
    availability: { callers: ["boss"] },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const snapshot: IntegrationAvailabilitySnapshot = {
    integrations: new Map([["gmail", { health: "active", accountLabel: null }]]),
    providers: new Map([
      ["google", [{ status: "active", scopes: new Set([readonlyScope]), accountLabel: null }]],
    ]),
    passthroughEnabled: new Map(),
  };

  assert.deepEqual(
    [
      ...availableToolNames(snapshot, [read, send, spawn], [], {
        caller: "sub_agent",
        hasThread: false,
      }),
    ],
    ["gmail.search"],
  );
});

describe("evaluateToolAvailability reason codes (#413)", () => {
  const scoped = "gmail.readonly";
  const search = liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description: "Search mail.",
    availability: { credential: { provider: "google", anyOfScopes: [scoped] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const chatOnly = liveTool({
    integration: "system",
    action: "read_chat_history",
    riskTier: "no_risk",
    description: "Read the thread.",
    availability: { requiresThread: true },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const bossOnly = liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    description: "Spawn child.",
    availability: { callers: ["boss"] },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });
  const ctx = { caller: "boss", hasThread: true } as const;
  const active = (scopes: string[]): IntegrationAvailabilitySnapshot => ({
    integrations: new Map([["gmail", { health: "active", accountLabel: null }]]),
    providers: new Map([
      ["google", [{ status: "active", scopes: new Set(scopes), accountLabel: null }]],
    ]),
    passthroughEnabled: new Map(),
  });
  const empty: IntegrationAvailabilitySnapshot = {
    integrations: new Map(),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };

  test("available when every gate passes", () => {
    assert.deepEqual(evaluateToolAvailability(active([scoped]), search, new Set(), ctx), {
      available: true,
    });
  });

  test("not_connected when the provider has no credential", () => {
    const result = evaluateToolAvailability(empty, search, new Set(), ctx);
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.code, "not_connected");
  });

  test("needs_reauth when a credential exists but is not active", () => {
    const snapshot: IntegrationAvailabilitySnapshot = {
      integrations: new Map([["gmail", { health: "needs_reauth", accountLabel: null }]]),
      providers: new Map([
        ["google", [{ status: "expired", scopes: new Set([scoped]), accountLabel: null }]],
      ]),
      passthroughEnabled: new Map(),
    };
    const result = evaluateToolAvailability(snapshot, search, new Set(), ctx);
    assert.equal(result.available === false && result.code, "needs_reauth");
  });

  test("missing_scope when active but the required scope is absent", () => {
    const result = evaluateToolAvailability(active(["gmail.other"]), search, new Set(), ctx);
    assert.equal(result.available === false && result.code, "missing_scope");
  });

  test("not_allowed when outside the workflow integration allowlist", () => {
    const result = evaluateToolAvailability(active([scoped]), search, new Set(["calendar"]), ctx);
    assert.equal(result.available === false && result.code, "not_allowed");
  });

  test("wrong_caller and requires_thread gate on run context", () => {
    assert.equal(
      evaluateToolAvailability(empty, bossOnly, new Set(), { caller: "sub_agent", hasThread: true })
        .available === false &&
        evaluateToolAvailability(empty, bossOnly, new Set(), {
          caller: "sub_agent",
          hasThread: true,
        }).code,
      "wrong_caller",
    );
    assert.equal(
      evaluateToolAvailability(empty, chatOnly, new Set(), { caller: "boss", hasThread: false })
        .available === false &&
        evaluateToolAvailability(empty, chatOnly, new Set(), { caller: "boss", hasThread: false })
          .code,
      "requires_thread",
    );
  });
});

test("exact load result activates only the registered chosen tool", () => {
  registerTool(gmailSearch);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "gmail.search" }), ["gmail.search"]);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "calendar.create_event" }), []);
  assert.deepEqual(applyExactToolLoad([], { ok: true, name: "not.real" }), []);
});

// #413: tools registered without hand-authored discovery still participate in
// search via the derived baseline, and strong-but-unavailable matches can be
// surfaced with a reason instead of silently dropped.
const notionCreate = liveTool({
  integration: "notion",
  action: "create_page",
  riskTier: "medium",
  description: "Create a Notion page under a parent.",
  inputSchema: z.object({ title: z.string(), content: z.string() }).strict(),
  execute: async () => ({ ok: true }),
});
const notionGet = liveTool({
  integration: "notion",
  action: "get_page",
  riskTier: "no_risk",
  description: "Fetch a page by id from the workspace.",
  inputSchema: z.object({ pageId: z.string() }).strict(),
  execute: async () => ({ ok: true }),
});

describe("derived-metadata discovery (#413)", () => {
  test("finds a tool with no authored discovery by capability, identity, and schema field", () => {
    const catalog = {
      tools: [notionCreate, notionGet],
      access: {
        allowedIntegrations: [],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [notionCreate.name, { available: true }],
          [notionGet.name, { available: true }],
        ]),
      },
    } as const;
    assert.equal(
      searchToolCatalog({ query: "create page", ...catalog })[0]?.name,
      "notion.create_page",
      "matches the derived verb + entity",
    );
    assert.ok(
      searchToolCatalog({ query: "notion", ...catalog }).some(
        (c) => c.name === "notion.create_page",
      ),
      "matches the derived identity tag",
    );
    assert.equal(
      searchToolCatalog({ query: "content", ...catalog })[0]?.name,
      "notion.create_page",
      "matches a derived schema-field entity",
    );
  });

  test("surfaces a strong unavailable match with a reason, sorted after runnable tools", () => {
    const access: ToolCatalogAccess = {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [notionGet.name, { available: true }],
        [
          notionCreate.name,
          { available: false, code: "not_connected", reason: "Notion is not connected." },
        ],
      ]),
    };
    const found = searchToolCatalog({
      query: "page",
      tools: [notionCreate, notionGet],
      access,
      includeUnavailable: true,
    });
    const create = found.find((c) => c.name === "notion.create_page");
    assert.equal(create?.availability, "unavailable");
    assert.equal(create?.unavailableReason, "Notion is not connected.");
    const get = found.find((c) => c.name === "notion.get_page");
    assert.equal(get?.availability, "available");
    assert.ok(
      found.indexOf(get!) < found.indexOf(create!),
      "runnable tools rank ahead of unavailable ones",
    );
  });

  test("hides unavailable matches unless the caller opts in", () => {
    const access: ToolCatalogAccess = {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [
          notionCreate.name,
          { available: false, code: "not_connected", reason: "Notion is not connected." },
        ],
      ]),
    };
    assert.deepEqual(
      searchToolCatalog({ query: "create page", tools: [notionCreate], access }),
      [],
      "no includeUnavailable → hidden",
    );
  });

  test("keeps weak incidental matches to unavailable tools hidden", () => {
    // "workspace" appears only in the description → summary-token score (2),
    // below the unavailable surfacing floor.
    const found = searchToolCatalog({
      query: "workspace",
      tools: [notionGet],
      access: {
        allowedIntegrations: [],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [
            notionGet.name,
            { available: false, code: "not_connected", reason: "Notion is not connected." },
          ],
        ]),
      },
      includeUnavailable: true,
    });
    assert.deepEqual(found, []);
  });

  test("never surfaces tools outside the workflow allowlist, available or not", () => {
    // The allowlist is a hard scope, so the evaluator marks an out-of-allowlist
    // tool `not_allowed`; the ranker hides it even with includeUnavailable set,
    // because that reason is not a gap the user can close in-run.
    const found = searchToolCatalog({
      query: "create page",
      tools: [notionCreate],
      access: {
        allowedIntegrations: ["gmail"],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [
            notionCreate.name,
            {
              available: false,
              code: "not_allowed",
              reason: "Outside this workflow's integration allowlist.",
            },
          ],
        ]),
      },
      includeUnavailable: true,
    });
    assert.deepEqual(found, []);
  });
});

// #414: the deterministic preloader must fire for natural chat phrasing, where
// the prompt is plural ("my pull requests") and the verb is a generic
// information-seeking word ("give me a summary of…") the narrow catalog verbs
// don't list — while still refusing to force-load a state-changing sibling.
describe("preload recall for natural phrasing (#414)", () => {
  const mailSearch = liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description: "Search mail.",
    discovery: { entities: ["email", "message"], verbs: ["search", "find"] },
    inputSchema: z.object({ query: z.string() }).strict(),
    execute: async () => ({ ok: true }),
  });
  const mailSend = liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    description: "Send a mail draft.",
    discovery: { entities: ["email", "draft"], verbs: ["send", "reply"] },
    inputSchema: z.object({ to: z.string() }).strict(),
    execute: async () => ({ ok: true }),
  });
  const catalog = {
    tools: [mailSearch, mailSend],
    access: {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [mailSearch.name, { available: true }],
        [mailSend.name, { available: true }],
      ]),
    },
  } as const;

  test("a plural prompt matches a singular authored entity", () => {
    // Without number-insensitive matching, "emails" would miss the entity "email"
    // and the tool would be invisible to a plural prompt.
    assert.ok(
      searchToolCatalog({ query: "anything new in my emails", ...catalog }).some(
        (candidate) => candidate.name === "gmail.search",
      ),
    );
  });

  test("a generic read request preloads the read tool but never the write sibling", () => {
    // "give"/"summary" are not catalog verbs, and "emails" is plural — the fix
    // makes both resolve. The high-risk send tool shares the entity but has no
    // matching catalog verb, so a read-flavored request must not force-load it.
    assert.deepEqual(
      preloadToolCatalog({
        prompt: "Give me a summary of my emails",
        activeTools: [],
        ...catalog,
      }),
      ["gmail.search"],
    );
  });

  test("a bare noun with no verb of any kind still preloads nothing", () => {
    assert.deepEqual(preloadToolCatalog({ prompt: "emails", activeTools: [], ...catalog }), []);
  });
});
