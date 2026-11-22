import { readFileSync } from "node:fs";
import path from "node:path";
import { type ChatModelTier, route, toModelMessages, type TranscriptMessage } from "@alfred/ai";
import {
  fetchUrlInput,
  getStringPath,
  isRecord,
  type JsonValue,
  loadToolInput,
  searchToolsInput,
  type McpCallModelInput,
  mcpCallModelInput,
  mcpToolInspectInputSchema,
  mcpToolSearchInputSchema,
  parseIanaTimezone,
  readUserContextInput,
  webSearchInput,
  spawnSubAgentInput,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { type Tool, generateText, isStepCount, tool, type ToolSet } from "ai";
import { Ajv } from "ajv";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { formatDateGrounding } from "@alfred/assistant/execution/grounding";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { buildSubAgentSystemPrompt } from "@alfred/assistant/execution/workflows/user-authored-brief";
import {
  appendChildResultNotes,
  joinSpawnedChildren,
} from "@alfred/assistant/execution/sub-agent-join";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// ADR-0077: guards the boss charter. In one prod thread the user asked for "more" three times
// and the boss never called web_search. Cases check the source class, not an exact path.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-07-02T07:30:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const READ_CONTEXT_TOOL = "system.read_user_context";

const WEB_SEARCH_TOOL = "system.web_search";

const SPAWN_SUB_AGENT_TOOL = "system.spawn_sub_agent";

const LOAD_TOOL_TOOL = "system.load_tool";

const SEARCH_TOOLS_TOOL = "system.search_tools";

// The production descriptions (`tool-runtime/internal/tools/system.ts`). Keep them in step.
const LOAD_TOOL_DESCRIPTION =
  "Load one exact available tool by the qualified name returned from system.search_tools. Prefer search_tools, which already loads its best registered hit; use this for a different name, including mcp.call for a connected-catalog ref. Its schema is available on the next model turn.";

const SEARCH_TOOLS_DESCRIPTION =
  "Search registered tools and connected MCP catalogs by capability. The result field loaded names the registered hit that is already loaded: call it directly on your next turn.";

/** Words that make the eval search rank the spawn tool first, as the registry discovery does. */
const DELEGATION_QUERY = /sub-?agent|delegat|spawn|investigat|research/i;

const SPAWN_SUB_AGENT_DESCRIPTION =
  "Spawn one focused sub-agent run with an isolated brief. Reserve it for a subtask that needs its own multi-step investigation across several sources (memory + the user's accounts + the web, or a long open-ended research question). It costs a second model run, and its tool calls are no more parallel than yours. Do NOT spawn one for a bounded lookup chain you can run directly — one search plus a batch or a few fetches from a single integration (a daily GitHub summary, today's calendar, one person's recent mail) is a direct call, not a delegation. " +
  "You can keep working after the spawn. Before your final answer, Alfred waits for each sub-agent you spawned and gives you its result as a note; then you answer with it.";

const FETCH_URL_TOOL = "system.fetch_url";

const MCP_LIST_TOOLS_TOOL = "mcp.list_tools";

const MCP_CALL_TOOL = "mcp.call";

// GitHub is a read-only MCP built-in (ADR-0094, ADR-0125). The model finds its tools in the
// catalog and calls them through mcp.call, so the eval names the remote tools.
const GITHUB_CONNECTION = { id: "mcp_conn_github", instanceKey: "github", label: "GitHub" };

const GITHUB_SEARCH_REMOTE = "search_pull_requests";

const GITHUB_READ_PR_REMOTE = "pull_request_read";

const MCP_INSPECT_TOOL = "mcp.inspect_tool";

/**
 * The hosted descriptors, captured on 2026-11-13 from the catalog of a connected
 * `https://api.githubcopilot.com/mcp/readonly` row (icons removed). Production validates the
 * arguments against these schemas before it sends a call, so the eval uses the same schemas.
 */
const githubDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

const GITHUB_DESCRIPTORS = z
  .array(githubDescriptorSchema)
  .parse(
    JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "fixtures/github-mcp-descriptors.json"),
        "utf8",
      ),
    ),
  );

const githubSchemaValidator = new Ajv({ strict: false, allErrors: true });

/** The ajv validator of each captured descriptor, as production compiles it. */
const GITHUB_ARGUMENT_VALIDATORS = new Map(
  GITHUB_DESCRIPTORS.map((descriptor) => [
    descriptor.name,
    githubSchemaValidator.compile(descriptor.inputSchema),
  ]),
);

/** The record the GitHub case asks about. A drill earns credit only on this record. */
const GITHUB_REQUESTED_PR = { owner: "acme", repo: "web", number: 482 };

// Gmail and Google Calendar are Google Workspace MCP built-ins (ADR-0126). The model finds their
// tools in the catalog and calls them through mcp.call, so the eval names the remote tools.
const GMAIL_CONNECTION = { id: "mcp_conn_gmail", instanceKey: "gmail", label: "Gmail" };

const CALENDAR_CONNECTION = {
  id: "mcp_conn_google_calendar",
  instanceKey: "calendar",
  label: "Google Calendar",
};

const GMAIL_SEARCH_REMOTE = "search_threads";

const GMAIL_READ_THREAD_REMOTE = "get_thread";

const CALENDAR_LIST_REMOTE = "list_events";

const TIERS: ChatModelTier[] = ["standard", "deep"];

// Depth means a lead and then a drill into a record from the same source. Unrelated calls do not count.
const WEB_INVESTIGATION_TOOLS = new Set<string>([
  READ_CONTEXT_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_URL_TOOL,
]);

const GITHUB_INVESTIGATION_TOOLS = new Set<string>([
  READ_CONTEXT_TOOL,
  MCP_LIST_TOOLS_TOOL,
  MCP_INSPECT_TOOL,
  MCP_CALL_TOOL,
]);

/** Catalog reads find a tool or its schema. They are not an angle of the investigation. */
const DISCOVERY_TOOLS = new Set<string>([READ_CONTEXT_TOOL, MCP_LIST_TOOLS_TOOL, MCP_INSPECT_TOOL]);

/**
 * Why production would refuse this call, or `null` when it would send it: the connection from the
 * catalog ref, and arguments that pass the captured schema of the remote tool.
 */
function githubCallRejection(input: unknown, remoteName: string): string | null {
  if (
    getStringPath(input, "remoteName") !== remoteName ||
    getStringPath(input, "connectionId") !== GITHUB_CONNECTION.id
  ) {
    return "The ref does not match the catalog. Use the ref from mcp.list_tools.";
  }

  const validate = GITHUB_ARGUMENT_VALIDATORS.get(remoteName);

  if (!validate) return `MCP tool '${remoteName}' is not in the current catalog.`;

  const args = isRecord(input) ? input.arguments : undefined;

  if (validate(args)) return null;

  return `Arguments for MCP tool '${remoteName}' failed its imported schema: ${githubSchemaValidator.errorsText(validate.errors)}`;
}

function isMcpCallTo(call: ToolCall, remoteName: string): boolean {
  return call.name === MCP_CALL_TOOL && githubCallRejection(call.input, remoteName) === null;
}

/** A valid `pull_request_read` of the record that the case asks about. */
function readsRequestedPullRequest(call: ToolCall): boolean {
  if (!isMcpCallTo(call, GITHUB_READ_PR_REMOTE)) return false;

  const args = isRecord(call.input) ? call.input.arguments : undefined;

  return (
    isRecord(args) &&
    args.owner === GITHUB_REQUESTED_PR.owner &&
    args.repo === GITHUB_REQUESTED_PR.repo &&
    args.pullNumber === GITHUB_REQUESTED_PR.number
  );
}

type McpConnection = typeof GMAIL_CONNECTION;

function googleMcpHit(connection: McpConnection, remoteName: string, description: string) {
  return {
    ref: {
      kind: "mcp",
      connectionId: connection.id,
      remoteName,
    },
    namespace: connection.instanceKey,
    connection,
    description,
  };
}

const GOOGLE_MCP_HITS = [
  googleMcpHit(
    GMAIL_CONNECTION,
    GMAIL_SEARCH_REMOTE,
    "Search the user's Gmail threads with Gmail search operators. Each hit has the thread id, sender, subject, and snippet.",
  ),
  googleMcpHit(
    GMAIL_CONNECTION,
    GMAIL_READ_THREAD_REMOTE,
    "Read one Gmail thread by its thread id: every message's sender, date, and body.",
  ),
  googleMcpHit(
    CALENDAR_CONNECTION,
    CALENDAR_LIST_REMOTE,
    "List the events on the user's calendar in a time range.",
  ),
];

/** The catalog page that mcp.list_tools returns, scoped like production. */
function googleMcpCatalog(input: {
  connectionId?: string | undefined;
  namespace?: string | undefined;
}) {
  const tools = GOOGLE_MCP_HITS.filter(
    (hit) =>
      (input.connectionId === undefined || hit.ref.connectionId === input.connectionId) &&
      (input.namespace === undefined || hit.namespace === input.namespace),
  );

  return { status: "tools", tools, nextCursor: null };
}

function isGoogleMcpCall(call: ToolCall, connection: McpConnection, remoteName: string): boolean {
  return (
    call.name === MCP_CALL_TOOL &&
    getStringPath(call.input, "connectionId") === connection.id &&
    getStringPath(call.input, "remoteName") === remoteName
  );
}

const MCP_LIST_TOOLS_DESCRIPTION =
  "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.";

const MCP_CALL_DESCRIPTION =
  "Invoke a tool on a connected MCP server. Supply the `connectionId` and `remoteName` of the ref returned by mcp.list_tools, plus `arguments` matching the tool schema.";

function mcpServerLine(connection: McpConnection, toolCount: number): string {
  return `- ${JSON.stringify(connection.label)} MCP server (connectionId ${connection.id}) — ${toolCount} tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`;
}

function calledCalendar(calls: readonly ToolCall[]): boolean {
  return calls.some((c) => isGoogleMcpCall(c, CALENDAR_CONNECTION, CALENDAR_LIST_REMOTE));
}

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  mcpServerLine(GMAIL_CONNECTION, 10),
  mcpServerLine(CALENDAR_CONNECTION, 9),
  "- system.read_user_context — Alfred's stored memory about the user",
  "- system.web_search — live public web search",
  "- system.fetch_url — read a known URL's page as text",
].join("\n");

const SYSTEM = buildChatSystemPrompt(
  formatDateGrounding(TIMEZONE, NOW),
  CONNECTED_SUMMARY,
  selfIdentityGrounding(),
);

const WEB_SEARCH_DESCRIPTION =
  "Search the live public web for current facts, public background on people or companies, and information outside Alfred's memory or connected services. Returns a synthesized answer plus result URLs/citations; use system.fetch_url on a promising result when you need to verify or read the page behind the search result.";

interface ToolCall {
  name: string;
  input: unknown;
}

interface TaskOutput {
  toolNames: string[];
  /** Inputs tell apart two web_search calls with different queries. */
  calls: ToolCall[];
  first: string | null;
  text: string;
  /** The delegation path, for the cases that can delegate. Absent where no case delegates. */
  delegation?: DelegationTrace;
}

/** What a delegation cost and whether it took the production path (ADR-0130 amendment (i)). */
interface DelegationTrace {
  /** The model loaded the lazy spawn tool before it spawned. */
  loadedBeforeSpawn: boolean;
  /** The runtime join gave the model the child result, and the model answered again. */
  joined: boolean;
  modelSteps: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  elapsedMs: number;
}

// Avoids threading the SDK's TOOLS/OUTPUT generics through a shared helper.
interface GenerateTextView {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> }>;
  text: string;
}

function collectOutput(result: GenerateTextView): TaskOutput {
  // A single-shot run still has one step.
  const calls: ToolCall[] = result.steps.flatMap((step) =>
    step.toolCalls.map((call) => ({ name: call.toolName, input: call.input })),
  );

  const toolNames = calls.map((c) => c.name);

  return { toolNames, calls, first: toolNames[0] ?? null, text: result.text };
}

function callQuery(input: unknown): string | null {
  return getStringPath(input, "query")?.toLowerCase().trim() ?? null;
}

/**
 * The prod bug: one web_search, then stop. Depth means two distinct web_search queries,
 * a web_search then a fetch_url, or a delegation to a sub-agent.
 */
interface DepthVerdict {
  ok: boolean;
  detail: string;
}

function bossDepthVerdict(calls: ToolCall[]): DepthVerdict {
  const webQueries = new Set<string>();
  let usedWeb = false;
  let usedFetch = false;
  let delegated = false;

  for (const c of calls) {
    if (c.name === WEB_SEARCH_TOOL) {
      usedWeb = true;
      const q = callQuery(c.input);

      if (q) webQueries.add(q);
    } else if (c.name === FETCH_URL_TOOL) {
      usedFetch = true;
    } else if (c.name === SPAWN_SUB_AGENT_TOOL) {
      delegated = true;
    }
  }

  const ok = delegated || webQueries.size >= 2 || (usedWeb && usedFetch);

  return {
    ok,
    detail: `distinct web queries=${webQueries.size}, web+fetch=${usedWeb && usedFetch}, delegated=${delegated}`,
  };
}

/** For the research sub-agent on any source: two distinct actions and one drill into a record. */
function investigationDepthVerdict(calls: ToolCall[], kind: "web" | "github"): DepthVerdict {
  const allowed = kind === "web" ? WEB_INVESTIGATION_TOOLS : GITHUB_INVESTIGATION_TOOLS;
  const relevant = calls.filter((c) => allowed.has(c.name) && !DISCOVERY_TOOLS.has(c.name));
  const offDomain = calls.filter((c) => !allowed.has(c.name));
  const distinct = new Set(relevant.map((c) => `${c.name}:${JSON.stringify(c.input)}`));

  const searched = relevant.some((c) =>
    kind === "web" ? c.name === WEB_SEARCH_TOOL : isMcpCallTo(c, GITHUB_SEARCH_REMOTE),
  );

  // GitHub: the drill must read the requested pull request, not any record the mock returns.
  const drilled = relevant.some((c) =>
    kind === "web" ? c.name === FETCH_URL_TOOL : readsRequestedPullRequest(c),
  );

  const ok = offDomain.length === 0 && distinct.size >= 2 && searched && drilled;

  return {
    ok,
    detail: `kind=${kind}, distinct relevant actions=${distinct.size}, searched=${searched}, drilled a record=${drilled}, off-domain=[${offDomain.map((c) => c.name).join(", ")}], tools=[${calls.map((c) => c.name).join(", ")}]`,
  };
}

interface SourceCase {
  input: string;
  expected: "web" | "calendar";
}

const SOURCE_CASES: SourceCase[] = [
  {
    input: "who is Lina Khan?",
    expected: "web",
  },
  {
    input: "what's the latest on Anthropic?",
    expected: "web",
  },
  {
    input: "what's on my calendar tomorrow?",
    expected: "calendar",
  },
];

function toolSurface(): Record<string, Tool> {
  const surface = {
    [READ_CONTEXT_TOOL]: tool({
      description:
        "Read Alfred's stored context about the user's profile, preferences, mail history by address, and recent memory.",
      inputSchema: readUserContextInput,
    }),
    [WEB_SEARCH_TOOL]: tool({
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: webSearchInput,
    }),
    [MCP_LIST_TOOLS_TOOL]: tool({
      description: MCP_LIST_TOOLS_DESCRIPTION,
      inputSchema: mcpToolSearchInputSchema,
      execute: async (input) => googleMcpCatalog(input),
    }),
    // No `execute`: the run stops at the remote call, and the scorer reads its target.
    [MCP_CALL_TOOL]: tool({
      description: MCP_CALL_DESCRIPTION,
      inputSchema: mcpCallModelInput,
    }),
  };

  return Object.assign<Record<string, Tool>, object>({}, surface);
}

async function runSourceChoice(input: string): Promise<TaskOutput> {
  const modelRoute = route("standard");

  const result = await generateText({
    model: modelRoute.model(),
    instructions: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    // The calendar read is a catalog lookup, then the remote call.
    stopWhen: isStepCount(3),
    tools: toolSurface(),
  });

  return collectOutput(result);
}

evalite<string, TaskOutput, SourceCase["expected"]>("Boss judgment — source ladder", {
  data: () => SOURCE_CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    serverEnv();

    try {
      return await runSourceChoice(input);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Reaches the expected source class",
      scorer: ({ output, expected }) => {
        const reachedWeb = output.toolNames.includes(WEB_SEARCH_TOOL);
        const reachedCalendar = calledCalendar(output.calls);
        const ok = expected === "web" ? reachedWeb : reachedCalendar;

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `called [${output.toolNames.join(", ")}]`
            : `expected ${expected}; called [${output.toolNames.join(", ") || "no tool"}]; replied: ${output.text.slice(0, 200)}`,
        };
      },
    },
    {
      name: "Does not over-search calendar requests",
      scorer: ({ output, expected }) => {
        if (expected !== "calendar") return { score: 1, metadata: "n/a" };

        const ok = calledCalendar(output.calls) && !output.toolNames.includes(WEB_SEARCH_TOOL);

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `calendar without web: [${output.toolNames.join(", ")}]`
            : `calendar control over-reached or missed: [${output.toolNames.join(", ") || "no tool"}]`,
        };
      },
    },
  ],
});

/** The Gmail MCP answers for the thin person replay: ClickUp notifications only. */
function thinGmailMcpResult(remoteName: string) {
  if (remoteName === GMAIL_SEARCH_REMOTE) {
    return {
      threads: [
        {
          id: "clickup_thread_1",
          from: "ClickUp <notifications@clickup.com>",
          subject: "Sakshi Jindal mentioned you in a task",
          snippet:
            "Sakshi Jindal commented on a ClickUp task. Open ClickUp to see the full task thread and project details.",
          date: "2026-07-01T10:15:00.000Z",
        },
        {
          id: "clickup_thread_2",
          from: "ClickUp <notifications@clickup.com>",
          subject: "Task updated by Sakshi Jindal",
          snippet:
            "A task involving Sakshi Jindal was updated in ClickUp. The details are in ClickUp.",
          date: "2026-07-01T09:00:00.000Z",
        },
      ],
    };
  }

  if (remoteName === GMAIL_READ_THREAD_REMOTE) {
    return {
      id: "clickup_thread_1",
      messages: [
        {
          from: "ClickUp <notifications@clickup.com>",
          subject: "Sakshi Jindal mentioned you in a task",
          body: "Sakshi Jindal commented on a ClickUp task. The email only contains a notification preview; open ClickUp for the task thread and project details.",
        },
      ],
    };
  }

  return { error: `Unknown tool ${remoteName} in the catalog.` };
}

/** The child of a delegating case: its id and the summary its run ends with. */
interface EvalChild {
  childRunId: string;
  subId: string;
  summary: string;
}

const EVAL_PARENT_RUN_ID = "run_eval_boss";

/**
 * Run the chat boss on the production delegation path (ADR-0130 amendment (i)). Spawn is lazy:
 * the model sees it only after `system.load_tool`. A spawn returns a running child, as in
 * production. When the boss answers after a spawn, the runtime join drops that answer, adds the
 * finished child's note through the production `joinSpawnedChildren` and
 * `appendChildResultNotes`, and calls the model again. The eval child is finished at the join,
 * so this is the fold path, with no park.
 */
async function runBossWithRuntimeJoin(args: {
  tier: ChatModelTier;
  messages: TranscriptMessage[];
  tools: ToolSet;
  maxSteps: number;
  child: EvalChild;
}): Promise<TaskOutput> {
  const modelRoute = route(args.tier);
  const startedMs = Date.now();
  let spawnLoaded = false;
  let loadedBeforeSpawn = false;

  const tools: ToolSet = {
    ...args.tools,
    // Production loads the best registered hit of a search, so a hit for spawn loads it.
    [SEARCH_TOOLS_TOOL]: tool({
      description: SEARCH_TOOLS_DESCRIPTION,
      inputSchema: searchToolsInput,
      execute: async ({ query }) => {
        if (!DELEGATION_QUERY.test(query)) return { ok: true, query, hits: [] };

        spawnLoaded = true;

        return {
          ok: true,
          query,
          loaded: SPAWN_SUB_AGENT_TOOL,
          hits: [{ name: SPAWN_SUB_AGENT_TOOL, title: "Spawn sub-agent", route: "direct" }],
        };
      },
    }),
    [LOAD_TOOL_TOOL]: tool({
      description: LOAD_TOOL_DESCRIPTION,
      inputSchema: loadToolInput,
      execute: async ({ name }) => {
        // As production: a tool that is already active loads nothing new.
        if (name in args.tools) {
          return {
            ok: true,
            name,
            alreadyActive: true,
            message: `${name} was already loaded, so this load changed nothing. Call ${name} directly; do not load it again.`,
          };
        }

        if (name !== SPAWN_SUB_AGENT_TOOL) {
          return { ok: false, status: "not_found", message: `${name} is not available here.` };
        }

        spawnLoaded = true;

        return { ok: true, name, message: `${name} is loaded. Call it on your next turn.` };
      },
    }),
    [SPAWN_SUB_AGENT_TOOL]: tool({
      description: SPAWN_SUB_AGENT_DESCRIPTION,
      inputSchema: spawnSubAgentInput,
      execute: async () => {
        loadedBeforeSpawn = spawnLoaded;

        return { ok: true, childRunId: args.child.childRunId, status: "running" };
      },
    }),
  };

  const baseNames = Object.keys(args.tools);

  const generate = (transcript: TranscriptMessage[]) =>
    generateText({
      model: modelRoute.model(),
      instructions: SYSTEM,
      messages: toModelMessages(transcript),
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      stopWhen: isStepCount(args.maxSteps),
      tools,
      // The lazy surface: spawn joins the model's tools only after its load.
      prepareStep: () => ({
        activeTools: [
          ...baseNames,
          SEARCH_TOOLS_TOOL,
          LOAD_TOOL_TOOL,
          ...(spawnLoaded ? [SPAWN_SUB_AGENT_TOOL] : []),
        ],
      }),
    });

  const first = await generate(args.messages);
  const firstOutput = collectOutput(first);
  const spawned = firstOutput.toolNames.includes(SPAWN_SUB_AGENT_TOOL);
  const answered = first.finishReason === "stop";

  const trace = (joined: boolean, results: (typeof first)[]): DelegationTrace => ({
    loadedBeforeSpawn,
    joined,
    modelSteps: results.reduce((n, r) => n + r.steps.length, 0),
    inputTokens: results.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0),
    cacheReadTokens: results.reduce(
      (n, r) => n + (r.usage.inputTokenDetails.cacheReadTokens ?? 0),
      0,
    ),
    cacheWriteTokens: results.reduce(
      (n, r) => n + (r.usage.inputTokenDetails.cacheWriteTokens ?? 0),
      0,
    ),
    elapsedMs: Date.now() - startedMs,
  });

  if (!spawned || !answered) return { ...firstOutput, delegation: trace(false, [first]) };

  const join = await joinSpawnedChildren(
    { parentRunId: EVAL_PARENT_RUN_ID, userId: "user_eval", foldedChildRunIds: [] },
    {
      listChildren: async () => [
        {
          id: args.child.childRunId,
          parentRunId: EVAL_PARENT_RUN_ID,
          outcome: {
            kind: "ended",
            status: "completed",
            output: {
              text: args.child.summary,
              scratchKey: `scratch.${args.child.subId}.summary`,
            },
            error: null,
          },
        },
      ],
      scheduleWake: async () => {},
    },
  );

  // Drop the answer that came before the child result, as the chat guard does.
  const responses = first.responseMessages;
  const kept = responses.at(-1)?.role === "assistant" ? responses.slice(0, -1) : responses;
  const second = await generate(appendChildResultNotes([...args.messages, ...kept], join.notes));
  const secondOutput = collectOutput(second);
  const calls = [...firstOutput.calls, ...secondOutput.calls];

  return {
    toolNames: calls.map((c) => c.name),
    calls,
    first: firstOutput.first,
    text: secondOutput.text,
    delegation: trace(true, [first, second]),
  };
}

/** A delegation must take the production path: load, spawn, then answer from the join. */
const delegationPathScorer = {
  name: "A delegation loads spawn and answers from the joined result",
  scorer: ({ output }: { output: TaskOutput }) => {
    const d = output.delegation;
    const spawned = output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);

    const cost = d
      ? `steps=${d.modelSteps}, input=${d.inputTokens}, cacheRead=${d.cacheReadTokens}, cacheWrite=${d.cacheWriteTokens}, ms=${d.elapsedMs}`
      : "no trace";

    if (!spawned) return { score: 1, metadata: `no delegation; ${cost}` };

    const ok = d?.loadedBeforeSpawn === true && d.joined && output.text.trim().length > 0;

    return {
      score: ok ? 1 : 0,
      metadata: `loadedBeforeSpawn=${d?.loadedBeforeSpawn}, joined=${d?.joined}; ${cost}; text=${output.text.slice(0, 200)}`,
    };
  },
};

async function runThinPersonResearchReplay(
  userMessage: string,
  tier: ChatModelTier,
): Promise<TaskOutput> {
  return await runBossWithRuntimeJoin({
    tier,
    messages: [
      { role: "user", content: "what do i know about sakshi" },
      {
        role: "assistant",
        content:
          "Sakshi Jindal appears in a couple of your calendar-invite emails, but I only have thin internal context on her.",
      },
      { role: "user", content: userMessage },
    ],
    // One more step than before: the lazy spawn costs a load.
    maxSteps: 6,
    child: {
      childRunId: "child_eval_sakshi",
      subId: "sakshi",
      summary:
        "Memory and Gmail are thin; ClickUp likely has the task details, and no confident public result was found.",
    },
    tools: {
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored mail history by address.",
        inputSchema: readUserContextInput,
        execute: async () => ({
          profile: null,
          people: [],
          facts: [],
          recentMemory: [],
        }),
      }),
      [MCP_LIST_TOOLS_TOOL]: tool({
        description: MCP_LIST_TOOLS_DESCRIPTION,
        inputSchema: mcpToolSearchInputSchema,
        execute: async (input) => googleMcpCatalog(input),
      }),
      [MCP_CALL_TOOL]: tool({
        description: MCP_CALL_DESCRIPTION,
        inputSchema: mcpCallModelInput,
        execute: async ({ remoteName }) => thinGmailMcpResult(remoteName),
      }),
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        // The web has nothing on this private colleague. The right move is to name ClickUp.
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "No public profile or background surfaced for this person in a work context; the search returned nothing on point.",
          citations: [],
          results: [],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "ClickUp notification",
          text: "This links back into the ClickUp app; the page requires signing in to ClickUp to see the task thread and project details.",
        }),
      }),
    },
  });
}

interface ReplayCase {
  message: string;
  tier: ChatModelTier;
}

const REPLAY_MESSAGES = ["find more about her", "can we know something more about her?"];

evalite<ReplayCase, TaskOutput, null>("Boss judgment — thin person research replay", {
  // The bug appeared on both tiers.
  data: () =>
    TIERS.flatMap((tier) =>
      REPLAY_MESSAGES.map((message) => ({ input: { message, tier }, expected: null })),
    ),
  task: async (input) => {
    serverEnv();

    try {
      return await runThinPersonResearchReplay(input.message, input.tier);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    delegationPathScorer,
    {
      name: "Reaches a new public/research source after thin internal results",
      scorer: ({ output }) => {
        const ok =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `tool path: ${output.toolNames.join(" -> ")}`
            : `stayed internal only: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 260)}`,
        };
      },
    },
    {
      name: "Names ClickUp as the richer unavailable source",
      scorer: ({ output }) => {
        const text = output.text.toLowerCase();
        const ok = text.includes("clickup") && (text.includes("unlock") || text.includes("detail"));

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? output.text.slice(0, 240)
            : `did not name the hidden source clearly; tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 240)}`,
        };
      },
    },
    {
      name: "Does not offer web search as an untried next step",
      scorer: ({ output }) => {
        const searchedOrDelegated =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);

        const text = output.text.toLowerCase();

        const puntsToFutureWeb =
          text.includes("i can look") ||
          text.includes("i can search") ||
          text.includes("if you know") ||
          text.includes("if you share");

        const ok = searchedOrDelegated || !puntsToFutureWeb;

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? "did not defer an available public lookup"
            : `offered lookup instead of doing it: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 260)}`,
        };
      },
    },
  ],
});

// Depth on a public person the web can answer, on both tiers. The web_search mock returns a
// low-confidence candidate with a citation, so the right move is to investigate further.

async function runPersonResearchDepth(
  userMessage: string,
  tier: ChatModelTier,
): Promise<TaskOutput> {
  return await runBossWithRuntimeJoin({
    tier,
    messages: [
      { role: "user", content: "what do we know about priya nair?" },
      {
        role: "assistant",
        content:
          "I don't have anything on Priya Nair in Alfred's memory or your email — just the name so far.",
      },
      { role: "user", content: userMessage },
    ],
    // One more step than before: the lazy spawn costs a load.
    maxSteps: 7,
    child: {
      childRunId: "child_eval_priya",
      subId: "priya",
      summary:
        "Priya Nair is a Product Manager at Foobar in Bengaluru per her LinkedIn and a conference bio, corroborated across two sources.",
    },
    tools: {
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored mail history by address.",
        inputSchema: readUserContextInput,
        execute: async () => ({ profile: null, people: [], facts: [], recentMemory: [] }),
      }),
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "A LinkedIn profile and a conference bio for a Priya Nair appear, but the match to your query isn't confirmed from this single search [1].",
          citations: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          results: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "Priya Nair — LinkedIn",
          text: "Priya Nair — Product Manager at Foobar (Bengaluru, India). Leads customer onboarding; previously an analyst. Speaks at product meetups.",
        }),
      }),
    },
  });
}

evalite<ReplayCase, TaskOutput, null>("Boss judgment — person research depth", {
  data: () =>
    TIERS.flatMap((tier) =>
      REPLAY_MESSAGES.map((message) => ({ input: { message, tier }, expected: null })),
    ),
  task: async (input) => {
    serverEnv();

    try {
      return await runPersonResearchDepth(input.message, input.tier);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    delegationPathScorer,
    {
      name: "Investigates in depth (>=2 angles, a fetch_url drill, or delegation)",
      scorer: ({ output }) => {
        const v = bossDepthVerdict(output.calls);

        return {
          score: v.ok ? 1 : 0,
          metadata: `${v.detail}; text=${output.text.slice(0, 200)}`,
        };
      },
    },
    {
      name: "Reaches the public web or delegates (doesn't stay internal)",
      scorer: ({ output }) => {
        const ok =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `tools=[${output.toolNames.join(", ")}]`
            : `stayed internal: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 200)}`,
        };
      },
    },
  ],
});

// Depth is not web-only. The sub-agent must go deep on the web (search, fetch_url) and on
// GitHub (the MCP pull request search, then the pull request read) with the same prompt.

const SUB_CONNECTED_SUMMARY = [
  "You are connected to these tools right now — call each as integration.action:",
  "- system.web_search — live public web search",
  "- system.fetch_url — read a known URL's page as text",
  `- "GitHub" MCP server (connectionId ${GITHUB_CONNECTION.id}) — 28 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
  "- system.read_user_context — Alfred's stored memory about the user",
].join("\n");

const SUB_SYSTEM = buildSubAgentSystemPrompt(
  formatDateGrounding(TIMEZONE, NOW),
  SUB_CONNECTED_SUMMARY,
  selfIdentityGrounding(),
  "sub-eval",
);

function githubDescriptor(remoteName: string) {
  const descriptor = GITHUB_DESCRIPTORS.find((d) => d.name === remoteName);

  if (!descriptor) throw new Error(`The fixture has no descriptor for ${remoteName}`);

  return descriptor;
}

function githubRef(remoteName: string) {
  return {
    kind: "mcp" as const,
    connectionId: GITHUB_CONNECTION.id,
    remoteName,
  };
}

const GITHUB_MCP_HITS = [GITHUB_SEARCH_REMOTE, GITHUB_READ_PR_REMOTE].map((remoteName) => ({
  ref: githubRef(remoteName),
  namespace: GITHUB_CONNECTION.instanceKey,
  connection: GITHUB_CONNECTION,
  description: githubDescriptor(remoteName).description,
}));

/** The production `mcp.call` result of a completed read: the MCP result with one JSON text block. */
function completedMcpResult(payload: JsonValue) {
  return {
    status: "completed",
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

/** GitHub reports a read failure as an MCP tool error, which `mcp.call` returns as `tool_error`. */
function githubToolError(text: string) {
  return { status: "tool_error", result: { isError: true, content: [{ type: "text", text }] } };
}

const PR_482 = {
  number: 482,
  title: "Refactor auth middleware",
  html_url: "https://github.com/acme/web/pull/482",
  state: "open",
  draft: false,
  user: { login: "lena" },
  body: "Splits the auth middleware into per-provider handlers. One review still requested; CI is green.",
  additions: 240,
  deletions: 180,
  changed_files: 7,
  mergeable_state: "blocked",
};

/** What GitHub returns for each `pull_request_read` method on the requested pull request. */
const PULL_REQUEST_READ_PAYLOADS = new Map<string, JsonValue>([
  ["get", PR_482],
  [
    "get_files",
    [
      { filename: "src/auth/middleware.ts", status: "modified", additions: 120, deletions: 160 },
      { filename: "src/auth/providers/google.ts", status: "added", additions: 60, deletions: 0 },
    ],
  ],
  ["get_diff", "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts\n@@ -1,4 +1,2 @@"],
  ["get_reviews", [{ user: { login: "omar" }, state: "CHANGES_REQUESTED" }]],
  ["get_status", { state: "success", total_count: 4 }],
  ["get_check_runs", { state: "success", total_count: 4 }],
]);

/**
 * The production path for an `mcp.call` to the GitHub MCP: a refused ref or invalid arguments
 * never reach GitHub, and a valid call returns only the record that it names.
 */
function githubMcpResult(input: McpCallModelInput) {
  const { remoteName } = input;
  const rejection = githubCallRejection(input, remoteName);

  if (rejection) {
    return {
      status: "failed",
      error:
        rejection +
        " Call mcp.inspect_tool with the same ref to read the exact schema, then call mcp.call again.",
    };
  }

  const args = input.arguments;

  if (remoteName === GITHUB_SEARCH_REMOTE) {
    return completedMcpResult({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          number: 482,
          title: PR_482.title,
          html_url: PR_482.html_url,
          state: "open",
          repository_url: "https://api.github.com/repos/acme/web",
        },
        {
          number: 471,
          title: "Add rate limits to the auth endpoints",
          html_url: "https://github.com/acme/web/pull/471",
          state: "closed",
          repository_url: "https://api.github.com/repos/acme/web",
        },
      ],
    });
  }

  if (
    args.owner !== GITHUB_REQUESTED_PR.owner ||
    args.repo !== GITHUB_REQUESTED_PR.repo ||
    args.pullNumber !== GITHUB_REQUESTED_PR.number
  ) {
    return githubToolError("failed to get pull request: GET 404 Not Found");
  }

  return completedMcpResult(
    (typeof args.method === "string" ? PULL_REQUEST_READ_PAYLOADS.get(args.method) : undefined) ??
      [],
  );
}

interface SubAgentCase {
  label: string;
  kind: "web" | "github";
  brief: string;
}

const SUB_AGENT_CASES: SubAgentCase[] = [
  {
    label: "web/person",
    kind: "web",
    brief:
      "Investigate the public professional background of Priya Nair, who works at a startup called Foobar — her role, location, and anything notable — and report what you find.",
  },
  {
    label: "github/pr",
    kind: "github",
    brief:
      "Investigate pull request #482 in the acme/web repository: what it changes, how big it is, and whether it looks ready to merge. Report what you find.",
  },
];

async function runSubAgentInvestigation(brief: string): Promise<TaskOutput> {
  const result = await generateText({
    model: route("subAgent").model(),
    instructions: SUB_SYSTEM,
    prompt: brief,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    stopWhen: isStepCount(6),
    tools: {
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "A LinkedIn profile and a company team page for a Priya Nair appear, but the details aren't confirmed from this single search [1].",
          citations: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          results: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "Priya Nair — profile",
          text: "Priya Nair — Product Manager at Foobar (Bengaluru). Leads customer onboarding; speaks at product meetups.",
        }),
      }),
      [MCP_LIST_TOOLS_TOOL]: tool({
        description: MCP_LIST_TOOLS_DESCRIPTION,
        inputSchema: mcpToolSearchInputSchema,
        execute: async () => ({ status: "tools", tools: GITHUB_MCP_HITS, nextCursor: null }),
      }),
      [MCP_INSPECT_TOOL]: tool({
        description:
          "Inspect one connected MCP tool by the ref returned by mcp.list_tools or system.search_tools. Pass only `ref`.",
        inputSchema: mcpToolInspectInputSchema,
        execute: async ({ ref }) =>
          ref.connectionId === GITHUB_CONNECTION.id &&
          GITHUB_DESCRIPTORS.some((d) => d.name === ref.remoteName)
            ? {
                status: "tool",
                ref,
                connection: GITHUB_CONNECTION,
                tool: githubDescriptor(ref.remoteName),
              }
            : { status: "not_found", ref, message: "This MCP tool is not in the current catalog." },
      }),
      [MCP_CALL_TOOL]: tool({
        description: MCP_CALL_DESCRIPTION,
        inputSchema: mcpCallModelInput,
        execute: async (input) => githubMcpResult(input),
      }),
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored mail history by address.",
        inputSchema: readUserContextInput,
        execute: async () => ({ profile: null, people: [], facts: [], recentMemory: [] }),
      }),
    },
  });

  return collectOutput(result);
}

evalite<SubAgentCase, TaskOutput, null>("Sub-agent — investigation depth (generic)", {
  data: () => SUB_AGENT_CASES.map((c) => ({ input: c, expected: null })),
  task: async (input) => {
    serverEnv();

    try {
      return await runSubAgentInvestigation(input.brief);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Works >=2 distinct angles and drills a specific record",
      scorer: ({ output, input }) => {
        const v = investigationDepthVerdict(output.calls, input.kind);

        return { score: v.ok ? 1 : 0, metadata: v.detail };
      },
    },
    {
      name: "Does not conclude from a single lookup",
      scorer: ({ output }) => {
        const ok = output.calls.length >= 2;

        return {
          score: ok ? 1 : 0,
          metadata: `total tool calls=${output.calls.length}; tools=[${output.toolNames.join(", ")}]`,
        };
      },
    },
  ],
});
