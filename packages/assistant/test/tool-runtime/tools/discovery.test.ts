import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  LoadableIntegrationSlug,
  ProviderAvailability,
  ToolAvailabilityResult,
  ToolName,
} from "@alfred/contracts";
import { z } from "zod";

import {
  preloadToolCatalog,
  resolveExactToolLoad,
  searchToolCatalog,
  type ToolCatalogAccess,
} from "@alfred/assistant/tool-runtime/discovery";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import {
  availableToolNames,
  evaluateToolAvailability,
  registerTool,
} from "../../../src/tool-runtime/internal/registry";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";

beforeEach(resetToolFixtures);

afterEach(resetToolFixtures);

const contactsSearch = liveTool({
  integration: "contacts",
  action: "search",
  riskTier: "no_risk",
  replay: "safe",
  description: "Search saved contacts.",
  discovery: {
    title: "Search contacts",
    summary: "Find people in the address book.",
    aliases: ["find person", "common task"],
    tags: ["people"],
    entities: ["person"],
    verbs: ["search"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const vercelRedeploy = liveTool({
  integration: "vercel",
  action: "redeploy",
  riskTier: "medium",
  replay: "safe",
  description: "Redeploy a Vercel deployment.",
  discovery: {
    title: "Redeploy",
    summary: "Ship a deployment again.",
    aliases: ["ship again", "common task"],
    tags: ["deploys"],
    entities: ["release"],
    verbs: ["ship"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const vercelList = liveTool({
  integration: "vercel",
  action: "list_deployments",
  riskTier: "no_risk",
  replay: "safe",
  description: "List Vercel deployments.",
  discovery: {
    title: "List deployments",
    summary: "Show recent deployments.",
    aliases: ["what's live", "common task"],
    tags: ["deploys"],
    entities: ["deploys", "deployment", "release"],
    verbs: ["list", "show", "read"],
  },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const contactsGet = liveTool({
  integration: "contacts",
  action: "get",
  riskTier: "low",
  replay: "safe",
  description: "Read a contact.",
  discovery: { aliases: ["mail task", "common task"], entities: ["mail"], verbs: ["handle"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const greleaseRedeploy = liveTool({
  integration: "gmail",
  action: "send_draft",
  riskTier: "high",
  replay: "safe",
  description: "Send mail messages.",
  discovery: { aliases: ["mail task", "common task"], entities: ["mail"], verbs: ["handle"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const systemFetch = liveTool({
  integration: "system",
  action: "fetch_url",
  riskTier: "no_risk",
  replay: "safe",
  description: "Read a known web page.",
  discovery: { aliases: ["read webpage"] },
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

const tools: readonly RegisteredTool[] = [contactsSearch, vercelRedeploy];

function provider(
  status: ProviderAvailability["status"],
  scopes: readonly string[],
): ProviderAvailability {
  return {
    credentialId: "cred_google",
    accountId: "account_google",
    status,
    scopes: new Set(scopes),
    installationId: null,
    accountLabel: null,
    metadata: {},
  };
}

function access(
  available: readonly LoadableIntegrationSlug[],
  allowedIntegrations: readonly IntegrationSlug[] = [],
): ToolCatalogAccess {
  const availableSet: ReadonlySet<string> = new Set(available);
  const allowed = new Set(allowedIntegrations);
  const availability = new Map<ToolName, ToolAvailabilityResult>();

  for (const tool of [contactsSearch, contactsGet, greleaseRedeploy, vercelRedeploy, vercelList]) {
    // Like evaluateToolCatalog, the allowlist is decided first as `not_allowed`.
    availability.set(
      tool.name,
      allowed.size > 0 && !allowed.has(tool.integration)
        ? {
            available: false,
            code: "not_allowed",
            reason: "Outside this workflow's integration allowlist.",
          }
        : availableSet.has(tool.integration)
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
      query: "contacts.search",
      tools,
      access: access(["contacts", "vercel"]),
    });

    assert.equal(found[0]?.name, "contacts.search");
    assert.equal(found[0].reason, "exact tool name");
    assert.equal("inputSchema" in found[0], false, "search must not expose schemas");
  });

  test("matches aliases", () => {
    const found = searchToolCatalog({
      query: "find person",
      tools,
      access: access(["contacts"]),
    });

    assert.equal(found[0]?.name, "contacts.search");
    assert.match(found[0].reason, /alias/);
  });

  test("matches tags, entities, and verbs", () => {
    const catalogAccess = access(["contacts", "vercel"]);
    assert.equal(
      searchToolCatalog({ query: "people", tools, access: catalogAccess })[0]?.name,
      "contacts.search",
    );
    assert.equal(
      searchToolCatalog({ query: "person", tools, access: catalogAccess })[0]?.name,
      "contacts.search",
    );
    assert.equal(
      searchToolCatalog({ query: "ship", tools, access: catalogAccess })[0]?.name,
      "vercel.redeploy",
    );
  });

  test("omits tools whose integration is unavailable", () => {
    const found = searchToolCatalog({ query: "find person", tools, access: access(["vercel"]) });
    assert.deepEqual(found, []);
  });

  test("omits tools outside the workflow allowlist", () => {
    const found = searchToolCatalog({
      query: "find person",
      tools,
      access: access(["contacts", "vercel"], ["vercel"]),
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
        context: { caller: "boss", interaction: "live_chat" },
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
    registerTool(projectsList);
    // No Vercel connection, so the model gets `not_connected`, not a generic refusal.
    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "vercel.list_projects",
        allowedIntegrations: [],
        context: { caller: "boss", interaction: "live_chat" },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      { ok: false, status: "not_connected", reason: "Vercel is not connected." },
    );
  });

  test("exact load reports the allowlist as not_allowed", async () => {
    registerTool(projectsList);
    assert.deepEqual(
      await resolveExactToolLoad({
        userId: "user_1",
        name: "vercel.list_projects",
        allowedIntegrations: ["gmail"],
        context: { caller: "boss", interaction: "live_chat" },
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
        name: "slides.nope",
        allowedIntegrations: [],
        context: { caller: "boss", interaction: "live_chat" },
        availability: {
          integrations: new Map(),
          providers: new Map(),
          passthroughEnabled: new Map(),
        },
      }),
      { ok: false, status: "unknown_tool", reason: "Tool 'slides.nope' is not registered." },
    );
  });

  test("deterministically preloads likely exact tools and skips active ones", () => {
    const args = {
      prompt: "Please ship the release tomorrow",
      tools,
      access: access(["contacts", "vercel"]),
    } as const;

    assert.deepEqual(preloadToolCatalog({ ...args, activeTools: [] }), ["vercel.redeploy"]);
    assert.deepEqual(preloadToolCatalog({ ...args, activeTools: ["vercel.redeploy"] }), []);
  });

  test("preloads intent matches without activating a sibling write from a generic noun", () => {
    const args = {
      tools: [vercelList, vercelRedeploy],
      access: access(["vercel"]),
      activeTools: [],
    } as const;

    assert.deepEqual(preloadToolCatalog({ ...args, prompt: "What's live on Friday?" }), [
      "vercel.list_deployments",
    ]);
    assert.deepEqual(preloadToolCatalog({ ...args, prompt: "deploys Friday" }), []);
  });

  test("applies the preload limit after removing already-active candidates", () => {
    const ranked = [vercelRedeploy, vercelList, contactsGet, contactsSearch, greleaseRedeploy];
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
  const readonlyScope = "contacts.readonly";

  const read = liveTool({
    integration: "contacts",
    action: "search",
    riskTier: "no_risk",
    replay: "safe",
    description: "Search contacts.",
    availability: { credential: { provider: "google", anyOfScopes: [readonlyScope] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const send = liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    replay: "safe",
    description: "Send mail.",
    availability: { credential: { provider: "google", anyOfScopes: ["gmail.send"] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const spawn = liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    replay: "safe",
    description: "Spawn child.",
    availability: { callers: ["boss"] },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const snapshot: IntegrationAvailabilitySnapshot = {
    integrations: new Map([
      ["contacts", { health: "active", accountLabel: null }],
      ["gmail", { health: "active", accountLabel: null }],
    ]),
    providers: new Map([["google", [provider("active", [readonlyScope])]]]),
    passthroughEnabled: new Map(),
  };

  assert.deepEqual(
    [
      ...availableToolNames(snapshot, [read, send, spawn], [], {
        caller: "sub_agent",
        interaction: "background",
      }),
    ],
    ["contacts.search"],
  );
});

describe("evaluateToolAvailability reason codes (#413)", () => {
  const scoped = "contacts.readonly";

  const search = liveTool({
    integration: "contacts",
    action: "search",
    riskTier: "no_risk",
    replay: "safe",
    description: "Search contacts.",
    availability: { credential: { provider: "google", anyOfScopes: [scoped] } },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const chatOnly = liveTool({
    integration: "system",
    action: "read_chat_history",
    riskTier: "no_risk",
    replay: "safe",
    description: "Read the thread.",
    availability: { requiresLiveChat: true },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const bossOnly = liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    replay: "safe",
    description: "Spawn child.",
    availability: { callers: ["boss"] },
    inputSchema: z.object({}).strict(),
    execute: async () => ({}),
  });

  const ctx = { caller: "boss", interaction: "live_chat" } as const;

  const active = (scopes: string[]): IntegrationAvailabilitySnapshot => ({
    integrations: new Map([["contacts", { health: "active", accountLabel: null }]]),
    providers: new Map([["google", [provider("active", scopes)]]]),
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
    assert.equal(result.code, "not_connected");
  });

  test("needs_reauth when a credential exists but is not active", () => {
    const snapshot: IntegrationAvailabilitySnapshot = {
      integrations: new Map([["contacts", { health: "needs_reauth", accountLabel: null }]]),
      providers: new Map([["google", [provider("needs_reauth", [scoped])]]]),
      passthroughEnabled: new Map(),
    };

    const result = evaluateToolAvailability(snapshot, search, new Set(), ctx);
    assert.equal(result.available === false && result.code, "needs_reauth");
  });

  test("missing_scope when active but the required scope is absent", () => {
    const result = evaluateToolAvailability(active(["contacts.other"]), search, new Set(), ctx);
    assert.equal(result.available === false && result.code, "missing_scope");
  });

  test("not_allowed when outside the workflow integration allowlist", () => {
    const result = evaluateToolAvailability(active([scoped]), search, new Set(["calendar"]), ctx);
    assert.equal(result.available === false && result.code, "not_allowed");
  });

  test("wrong_caller and requires_thread gate on run context", () => {
    const wrongCaller = evaluateToolAvailability(empty, bossOnly, new Set(), {
      caller: "sub_agent",
      interaction: "live_chat",
    });

    assert.equal(wrongCaller.available === false && wrongCaller.code, "wrong_caller");

    const requiresThread = evaluateToolAvailability(empty, chatOnly, new Set(), {
      caller: "boss",
      interaction: "background",
    });

    assert.equal(requiresThread.available === false && requiresThread.code, "requires_thread");
  });
});

// Tools without authored discovery use the derived baseline. Strong unavailable matches show a
// reason.
const projectsList = liveTool({
  integration: "vercel",
  action: "list_projects",
  riskTier: "medium",
  replay: "safe",
  description: "List Vercel projects under a team.",
  inputSchema: z.object({ title: z.string(), content: z.string() }).strict(),
  execute: async () => ({ ok: true }),
});

const deploymentsList = liveTool({
  integration: "vercel",
  action: "list_deployments",
  riskTier: "no_risk",
  replay: "safe",
  description: "Fetch deployments by id from the workspace.",
  inputSchema: z.object({ deploymentId: z.string() }).strict(),
  execute: async () => ({ ok: true }),
});

describe("derived-metadata discovery (#413)", () => {
  test("finds a tool with no authored discovery by capability, identity, and schema field", () => {
    const catalog = {
      tools: [projectsList, deploymentsList],
      access: {
        allowedIntegrations: [],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [projectsList.name, { available: true }],
          [deploymentsList.name, { available: true }],
        ]),
      },
    } as const;

    assert.equal(
      searchToolCatalog({ query: "list projects", ...catalog })[0]?.name,
      "vercel.list_projects",
      "matches the derived verb + entity",
    );
    assert.ok(
      searchToolCatalog({ query: "vercel", ...catalog }).some(
        (c) => c.name === "vercel.list_projects",
      ),
      "matches the derived identity tag",
    );
    assert.equal(
      searchToolCatalog({ query: "content", ...catalog })[0]?.name,
      "vercel.list_projects",
      "matches a derived schema-field entity",
    );
  });

  test("surfaces a strong unavailable match with a reason, sorted after runnable tools", () => {
    const access: ToolCatalogAccess = {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [deploymentsList.name, { available: true }],
        [
          projectsList.name,
          { available: false, code: "not_connected", reason: "Vercel is not connected." },
        ],
      ]),
    };

    const found = searchToolCatalog({
      query: "list",
      tools: [projectsList, deploymentsList],
      access,
      includeUnavailable: true,
    });

    const create = found.find((c) => c.name === "vercel.list_projects");
    assert.equal(create?.availability, "unavailable");
    assert.equal(create.unavailableReason, "Vercel is not connected.");
    const get = found.find((c) => c.name === "vercel.list_deployments");
    assert.equal(get?.availability, "available");
    assert.ok(
      found.indexOf(get) < found.indexOf(create),
      "runnable tools rank ahead of unavailable ones",
    );
  });

  test("hides unavailable matches unless the caller opts in", () => {
    const access: ToolCatalogAccess = {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [
          projectsList.name,
          { available: false, code: "not_connected", reason: "Vercel is not connected." },
        ],
      ]),
    };

    assert.deepEqual(
      searchToolCatalog({ query: "list projects", tools: [projectsList], access }),
      [],
      "no includeUnavailable → hidden",
    );
  });

  test("keeps weak incidental matches to unavailable tools hidden", () => {
    // A description-only match scores below the floor for unavailable tools.
    const found = searchToolCatalog({
      query: "workspace",
      tools: [deploymentsList],
      access: {
        allowedIntegrations: [],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [
            deploymentsList.name,
            { available: false, code: "not_connected", reason: "Vercel is not connected." },
          ],
        ]),
      },
      includeUnavailable: true,
    });

    assert.deepEqual(found, []);
  });

  test("never surfaces tools outside the workflow allowlist, available or not", () => {
    // The user cannot fix `not_allowed` in-run, so it stays hidden even with includeUnavailable.
    const found = searchToolCatalog({
      query: "list projects",
      tools: [projectsList],
      access: {
        allowedIntegrations: ["gmail"],
        availability: new Map<ToolName, ToolAvailabilityResult>([
          [
            projectsList.name,
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

// Plural nouns and generic read verbs must preload, but never a write sibling.
describe("preload recall for natural phrasing (#414)", () => {
  const releaseList = liveTool({
    integration: "vercel",
    action: "list_deployments",
    riskTier: "no_risk",
    replay: "safe",
    description: "Search releases.",
    discovery: { entities: ["release", "build"], verbs: ["search", "find"] },
    inputSchema: z.object({ query: z.string() }).strict(),
    execute: async () => ({ ok: true }),
  });

  const releaseRedeploy = liveTool({
    integration: "vercel",
    action: "redeploy",
    riskTier: "high",
    replay: "safe",
    description: "Ship a release again.",
    discovery: { entities: ["release", "rollout"], verbs: ["ship", "promote"] },
    inputSchema: z.object({ to: z.string() }).strict(),
    execute: async () => ({ ok: true }),
  });

  const catalog = {
    tools: [releaseList, releaseRedeploy],
    access: {
      allowedIntegrations: [],
      availability: new Map<ToolName, ToolAvailabilityResult>([
        [releaseList.name, { available: true }],
        [releaseRedeploy.name, { available: true }],
      ]),
    },
  } as const;

  test("a plural prompt matches a singular authored entity", () => {
    assert.ok(
      searchToolCatalog({ query: "anything new in my releases", ...catalog }).some(
        (candidate) => candidate.name === "vercel.list_deployments",
      ),
    );
  });

  test("a generic read request preloads the read tool but never the write sibling", () => {
    // The redeploy tool shares the entity but no verb, so a read request must not load it.
    assert.deepEqual(
      preloadToolCatalog({
        prompt: "Give me a summary of my releases",
        activeTools: [],
        ...catalog,
      }),
      ["vercel.list_deployments"],
    );
  });

  test("a bare noun with no verb of any kind still preloads nothing", () => {
    assert.deepEqual(preloadToolCatalog({ prompt: "releases", activeTools: [], ...catalog }), []);
  });
});
