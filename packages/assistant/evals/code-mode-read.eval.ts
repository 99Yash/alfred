import path from "node:path";
import { route } from "@alfred/ai";
import {
  CODE_RUN_TOOL,
  codeRunInput,
  type HostReadRefusal,
  type JsonValue,
  mcpCallInput,
  mcpCallModelInput,
  parseIanaTimezone,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { formatRuntimeTimeGrounding } from "@alfred/assistant/execution/grounding";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { registerBuiltinTools } from "../src/tool-runtime/builtin-tools";
import { readHostBindings, timeNowBinding } from "../src/tool-runtime/code-mode/host-bindings";
import { jsonBytes } from "../src/tool-runtime/code-mode/result-budget";
import { runReadProgram } from "../src/tool-runtime/code-mode/run-read-program";
import { newHostCallLedger } from "../src/tool-runtime/internal/dispatch/host-call-ledger";
import {
  getTool,
  listRegisteredTools,
  type HostCallEntry,
  type HostReadOutcome,
  type HostReadRequest,
} from "../src/tool-runtime/internal/registry";
import { currentTimeSnapshot } from "../src/tool-runtime/internal/tools/system";

// ADR-0124: the driver run `run_s7yi1ymxakcj` (2026-11-08). The user asked chat for "alfred's
// issues", and the boss made 41 `github.get_issue` calls, one model step each. The context grew
// from about 8k to about 48k tokens, and the last turn took 125 s. In a `code_run` chat the same
// question must take a few steps and a small context. The model under test is the chat model
// with the `code_run` prompt and the real `system.code_run` description. Its scripts run in the
// real sandbox (`runReadProgram`) against fake host functions, so no database, no network, and
// no GitHub (#898). No trace of that run is captured, so the fixtures are synthetic: they keep
// its shape (a repo with 41 open issues, a list that has no bodies, one read for each body).
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant exec evalite run code-mode-read`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

registerBuiltinTools();

const NOW = new Date("2026-11-08T06:10:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

/** The chat turn ceiling. A script waits on its reads inside one step. */
const EVAL_TIMEOUT_MS = 180_000;

/** Room to finish, so the step scorer reads the real count. The prod run took 43 steps. */
const MAX_STEPS = 12;

const STEP_CEILING = 4;

/** The prod run reached about 48k input tokens on its last step. */
const PEAK_INPUT_TOKEN_CEILING = 20_000;

const OWNER = "99Yash";

const REPO = "alfred";

const GITHUB_CONNECTION = { id: "mcp_conn_github", instanceKey: "github", label: "GitHub" };

const LIST_ISSUES_REMOTE = "list_issues";

const ISSUE_READ_REMOTE = "issue_read";

/** Like the hosted GitHub MCP read-only server: no output schema, so a script samples first. */
const GITHUB_DESCRIPTORS = [
  {
    name: LIST_ISSUES_REMOTE,
    description:
      "List issues in a GitHub repository. Returns the number, title, state, labels, and URL of each issue, without its body. Paginate with `after`.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["OPEN", "CLOSED"] },
        perPage: { type: "number", minimum: 1, maximum: 100 },
        after: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: ISSUE_READ_REMOTE,
    description:
      "Read one issue of a GitHub repository. `get` returns the issue with its body; `get_comments` returns its comments.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["get", "get_comments"] },
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
      },
      required: ["method", "owner", "repo", "issue_number"],
    },
  },
] as const;

const ISSUE_TITLES = [
  "Chat: Stop does not cancel a running sub-agent",
  "Triage: a newsletter from a known sender lands in Reply",
  "Briefing: the morning brief repeats yesterday's meetings",
  "Calendar MCP: an all-day event shows at 05:30",
  "Gmail MCP: a search with a quoted phrase returns nothing",
  "Artifacts: a PDF export clips the last table row",
  "Composer: an image paste loses its file name",
  "Approval card: the edit field drops a trailing newline",
  "Sub-agent: an await after a crash waits forever",
  "Memory: a confirmed fact shows twice in read_user_context",
  "Search tools: a hit for a disconnected service ranks first",
  "Vercel: list_deployments times out on a big team",
  "Contacts: search ignores a nickname alias",
  "Workflows: an allowlist with mcp fails activation",
  "Compaction: a summary drops an attachment id",
  "Settings: the timezone picker resets on reload",
  "Sync: Replicache poke storm after a long offline gap",
  "Triage: a GitHub review request is filed as FYI",
  "Chat: the cite chip opens the redirect URL",
  "MCP broker: catalog_stale after a server restart",
  "Briefing: a lookout never matches a forwarded mail",
  "Todos: a resolved todo comes back after a resync",
  "Auth: a session cookie is not refreshed on wake",
  "Web search: a non-English query returns English results",
  "fetch_url: a 301 to http is refused",
  "Artifacts: a deck page loses its speaker notes",
  "Chat history: fetch by id fails for a tool call",
  "Scratch: a shared key from a sub-agent is not visible",
  "Notifications: an approval reminder fires after approval",
  "Triage: a calendar invite reply is labelled Meeting twice",
  "Corpus: a Drive doc with comments indexes twice",
  "Sheets: append_values writes to the wrong tab",
  "Cold start: the first sync of a large inbox stalls",
  "Chat: the tool trail hides a failed read",
  "Gmail MCP: a thread with 100 messages truncates silently",
  "GitHub MCP: a private repo returns 404 for the owner",
  "Code Mode: the index omits the input of a nested schema",
  "Logging: a credential id appears in a warn line",
  "Usage report: model prices miss the cached-input rate",
  "Instructions: forget_instruction leaves the derived rule",
  "Landing: the hero video does not autoplay on iOS",
] as const;

/** Repeated in each body, so a direct read of every issue costs about what the prod run paid. */
const ISSUE_CONTEXT = [
  "## Context",
  "Seen in production on the owner's account. The logs show the request, the dispatch row, and the result envelope, and the trace has every span. No user data is attached here.",
  "## Steps",
  "1. Open a new chat thread on the web app.",
  "2. Do the action in the title with a connected account.",
  "3. Compare the result with the expected behavior below.",
  "## Expected",
  "The action completes, and the chat trail and the stored rows agree with what the user sees.",
  "## Notes",
  "The fix must keep the dispatch gate, the staging row, and the span for each call. Add the gate or the parse at the owning boundary, not a patch at the call site. ".repeat(
    6,
  ),
].join("\n");

interface IssueFixture {
  number: number;
  title: string;
  label: string;
  body: string;
}

const OPEN_ISSUES: readonly IssueFixture[] = ISSUE_TITLES.map((title, index) => ({
  number: 1180 + index * 3,
  title,
  label: title.slice(0, title.indexOf(":")).toLowerCase(),
  body: `${title}.\n\n${ISSUE_CONTEXT}`,
}));

const DEFAULT_PAGE_SIZE = 30;

function githubRef(remoteName: string) {
  return {
    kind: "mcp" as const,
    connectionId: GITHUB_CONNECTION.id,
    remoteName,
  };
}

/** The `ReadUserContextResult` the run had: the GitHub login and the `alfred` project. */
const USER_CONTEXT = {
  profile: {
    name: "Owner",
    email: "owner@example.com",
    currentCompany: null,
    currentRole: "Software engineer",
    currentWork: "Building Alfred, a personal assistant",
    currentLocation: null,
    bioSummary: null,
    identityFacts: [{ key: "github_username", value: OWNER, confidence: 1 }],
  },
  activeIntegrations: [{ provider: "github", accountLabel: OWNER }],
  confirmedFacts: [],
  preferences: [],
  entities: [
    {
      id: "ent_project_alfred",
      kind: "project",
      canonicalName: "alfred",
      aliases: ["Alfred"],
      metadata: { repository: `${OWNER}/${REPO}` },
    },
  ],
  relations: [],
  recentMemory: [],
} satisfies JsonValue;

/** The connected summary of a `code_run` run, as `buildConnectedSummaryFromAvailability` writes it. */
const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now. Read from them inside system.code_run, where each read tool is an async function with its own name (for example contacts.search) and mcp.read reads an MCP server's tool. Call a write directly as integration.action, and an MCP server's write through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it. A line marks the calls that wait for the user's approval: each one shows the user an approval card, and that card is the confirmation. Any other call may run at once.",
  `- "GitHub" MCP server (connectionId ${GITHUB_CONNECTION.id}) — 2 tools; find one with system.search_tools, or with mcp.list_tools inside system.code_run, scoped to this connectionId; read with mcp.read inside the script, and write through mcp.call`,
].join("\n");

/** The production `mcp.call` result of a completed read: the MCP result with one JSON text block. */
function completedMcpResult(payload: JsonValue): JsonValue {
  return {
    status: "completed",
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

/** GitHub reports a read failure as an MCP tool error, which `mcp.call` returns as `tool_error`. */
function githubToolError(text: string): JsonValue {
  return {
    ok: false,
    status: "tool_error",
    result: { isError: true, content: [{ type: "text", text }] },
  };
}

const listIssuesArgs = z.object({
  owner: z.string(),
  repo: z.string(),
  state: z.enum(["OPEN", "CLOSED"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  after: z.string().optional(),
});

const issueReadArgs = z.object({
  method: z.enum(["get", "get_comments"]),
  owner: z.string(),
  repo: z.string(),
  issue_number: z.number().int(),
});

/** What the fake host saw. The ledger of `runReadProgram` has the paths; this has the targets. */
interface HostRecord {
  bodiesRead: Set<number>;
}

function isAlfredRepo(args: { owner: string; repo: string }): boolean {
  return args.owner.toLowerCase() === OWNER.toLowerCase() && args.repo.toLowerCase() === REPO;
}

function listIssues(rawArgs: unknown): JsonValue {
  const parsed = listIssuesArgs.safeParse(rawArgs);

  if (!parsed.success) return githubToolError(`invalid arguments: ${parsed.error.message}`);

  const args = parsed.data;

  if (!isAlfredRepo(args)) return githubToolError("failed to list issues: GET 404 Not Found");

  const issues = args.state === "CLOSED" ? [] : OPEN_ISSUES;
  const start = args.after ? Number(args.after) : 0;
  const pageSize = args.perPage ?? DEFAULT_PAGE_SIZE;
  const page = issues.slice(start, start + pageSize);
  const end = start + page.length;

  return completedMcpResult({
    issues: page.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: "OPEN",
      labels: [issue.label],
      html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}`,
    })),
    pageInfo: {
      hasNextPage: end < issues.length,
      endCursor: end < issues.length ? String(end) : null,
    },
    totalCount: issues.length,
  });
}

function readIssue(rawArgs: unknown, record: HostRecord): JsonValue {
  const parsed = issueReadArgs.safeParse(rawArgs);

  if (!parsed.success) return githubToolError(`invalid arguments: ${parsed.error.message}`);

  const args = parsed.data;
  const issue = OPEN_ISSUES.find((candidate) => candidate.number === args.issue_number);

  if (!isAlfredRepo(args) || !issue)
    return githubToolError("failed to get issue: GET 404 Not Found");

  if (args.method === "get_comments") return completedMcpResult([]);

  record.bodiesRead.add(issue.number);

  return completedMcpResult({
    number: issue.number,
    title: issue.title,
    state: "OPEN",
    labels: [issue.label],
    user: { login: OWNER },
    comments: 0,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}`,
    body: issue.body,
  });
}

/** A fixture outcome, before {@link withCallFacts} adds what dispatch sets. */
type FakeOutcome =
  | { kind: "executed"; value: JsonValue }
  | { kind: "refused"; refusal: HostReadRefusal; message: string };

/** The call facts and evidence that dispatch sets. The eval grades the script, not the record. */
async function withCallFacts(
  request: HostReadRequest,
  outcome: Promise<FakeOutcome>,
): Promise<HostReadOutcome> {
  const call = {
    callId: `eval#${request.requestIndex}`,
    toolName: request.toolName,
    input: null,
    stagingId: null,
  };

  const settled = await outcome;

  return settled.kind === "executed"
    ? { ...settled, bytes: jsonBytes(settled.value), call, evidence: undefined }
    : { ...settled, call };
}

/** The fake `hostRead`: what the nested dispatch of each read would return for these fixtures. */
async function fakeHostRead(request: HostReadRequest, record: HostRecord): Promise<FakeOutcome> {
  if (request.toolName === "system.read_user_context") {
    return { kind: "executed", value: USER_CONTEXT };
  }

  if (request.toolName === "mcp.list_tools") {
    return {
      kind: "executed",
      value: {
        status: "tools",
        tools: GITHUB_DESCRIPTORS.map((descriptor) => ({
          ref: githubRef(descriptor.name),
          namespace: GITHUB_CONNECTION.instanceKey,
          connection: GITHUB_CONNECTION,
          description: descriptor.description,
        })),
        nextCursor: null,
      },
    };
  }

  // Like prod for a repo that no ingested document names: a valid, empty context.
  if (request.toolName === "system.search_context") {
    return {
      kind: "executed",
      value: { ok: true, text: "", includedCount: 0, omittedCount: 0, truncated: false },
    };
  }

  if (request.toolName === "mcp.inspect_tool") return inspectTool(request.input);

  if (request.toolName === "mcp.call") return callGithub(request.input, record);

  return {
    kind: "refused",
    refusal: "failed",
    message: `This eval has no data for ${request.toolName}`,
  };
}

const NOT_IN_CATALOG: FakeOutcome = {
  kind: "refused",
  refusal: "invalid_input",
  message: "This MCP tool is not in the catalog.",
};

const inspectToolArgs = z.object({ ref: z.object({ remoteName: z.string() }) });

function inspectTool(input: unknown): FakeOutcome {
  const parsed = inspectToolArgs.safeParse(input);
  const remoteName = parsed.success ? parsed.data.ref.remoteName : null;
  const descriptor = GITHUB_DESCRIPTORS.find((candidate) => candidate.name === remoteName);

  if (!descriptor) return NOT_IN_CATALOG;

  return {
    kind: "executed",
    value: {
      status: "tool",
      ref: githubRef(descriptor.name),
      connection: GITHUB_CONNECTION,
      tool: descriptor,
    },
  };
}

function callGithub(input: unknown, record: HostRecord): FakeOutcome {
  // The host input: the pass pins a revision, so this parses the runtime schema.
  const call = mcpCallInput.safeParse(input);

  if (!call.success || call.data.connectionId !== GITHUB_CONNECTION.id) {
    return {
      kind: "refused",
      refusal: "invalid_input",
      message: "Use the ref from mcp.list_tools.",
    };
  }

  if (call.data.remoteName === LIST_ISSUES_REMOTE) {
    return { kind: "executed", value: listIssues(call.data.arguments) };
  }

  if (call.data.remoteName === ISSUE_READ_REMOTE) {
    return { kind: "executed", value: readIssue(call.data.arguments, record) };
  }

  return NOT_IN_CATALOG;
}

interface TaskOutput {
  toolNames: string[];
  steps: number;
  inputTokensPerStep: number[];
  ledger: HostCallEntry[];
  scripts: ScriptRecord[];
  bodiesRead: number[];
  text: string;
}

/** One `system.code_run` call, kept so a failed case shows what the model wrote. */
interface ScriptRecord {
  source: string;
  status: string;
  message: string | null;
  reads: number;
}

const READ_TOOLS = listRegisteredTools().filter((registered) => registered.codeModeRead);

const CODE_RUN_DESCRIPTION = getTool(CODE_RUN_TOOL)?.description;

async function runCodeModeChat(prompt: string): Promise<TaskOutput> {
  if (!CODE_RUN_DESCRIPTION) throw new Error("system.code_run is not registered");

  const record: HostRecord = { bodiesRead: new Set() };
  const ledger: HostCallEntry[] = [];
  const scripts: ScriptRecord[] = [];

  const hosts = [
    ...readHostBindings({
      readTools: READ_TOOLS,
      hostRead: (request) => withCallFacts(request, fakeHostRead(request, record)),
      // One fixed catalog: the pass pins this revision (ADR-0116 amendment 2026-11-18).
      readCatalogRevision: async () => "rev_github_code_mode_eval",
    }),
    // The clock of the fixture, so a script's local dates match the fixture's mail and events.
    timeNowBinding(() => currentTimeSnapshot(TIMEZONE, NOW)),
  ];

  const result = await generateText({
    model: route("standard").model(),
    instructions: buildChatSystemPrompt("", CONNECTED_SUMMARY, selfIdentityGrounding(), "code_run"),
    messages: [
      { role: "assistant", content: formatRuntimeTimeGrounding(TIMEZONE, NOW) },
      { role: "user", content: prompt },
    ],
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    stopWhen: isStepCount(MAX_STEPS),
    tools: {
      [CODE_RUN_TOOL]: tool({
        description: CODE_RUN_DESCRIPTION,
        inputSchema: codeRunInput,
        execute: async ({ source }) => {
          const outcome = await runReadProgram({
            source,
            hosts,
            ledger: newHostCallLedger(),
            runId: "run_code_mode_eval",
          });

          // Each script numbers its reads from 1, so the eval keeps its own order.
          ledger.push(
            ...outcome.ledger.map((entry) => ({ ...entry, index: ledger.length + entry.index })),
          );
          scripts.push({
            source,
            status: outcome.status,
            message: outcome.status === "completed" ? null : outcome.message,
            reads: outcome.ledger.length,
          });

          const reads = {
            total: outcome.ledger.length,
            failed: outcome.ledger.filter((entry) => entry.kind !== "executed").length,
          };

          return outcome.status === "completed"
            ? { status: outcome.status, value: outcome.value, reads }
            : { status: outcome.status, message: outcome.message, reads };
        },
      }),
      // The write path stays on the surface. No `execute`: a direct read here ends the run.
      "mcp.call": tool({
        description:
          "Invoke a tool on a connected MCP server. Supply the `connectionId` and `remoteName` of the ref, plus `arguments` matching the tool schema.",
        inputSchema: mcpCallModelInput,
      }),
    },
  });

  return {
    toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    steps: result.steps.length,
    inputTokensPerStep: result.steps.map((step) => step.usage.inputTokens ?? 0),
    ledger,
    scripts,
    bodiesRead: [...record.bodiesRead].toSorted((a, b) => a - b),
    text: result.text,
  };
}

/** A number counts when the answer writes it as `#1180` or as a bare `1180`. */
function issuesNamed(text: string): number {
  return OPEN_ISSUES.filter(
    (issue) => new RegExp(`(^|\\D)${issue.number}(\\D|$)`).test(text) || text.includes(issue.title),
  ).length;
}

interface Case {
  prompt: string;
}

const CASES: Case[] = [{ prompt: "what are alfred's open issues? give me the gist of each one" }];

evalite<Case, TaskOutput, null>("Code Mode — the chat read path (run_s7yi1ymxakcj)", {
  data: () => CASES.map((input) => ({ input, expected: null })),
  task: async (input) => {
    serverEnv();

    try {
      return await runCodeModeChat(input.prompt);
    } catch (error) {
      return {
        toolNames: [],
        steps: 0,
        inputTokensPerStep: [],
        ledger: [],
        scripts: [],
        bodiesRead: [],
        text: `ERROR: ${toMessage(error)}`,
      };
    }
  },
  scorers: [
    {
      // ADR-0124 decision 1. A direct `mcp.call` read is the leak the flag must stop.
      name: "Every read runs in a script",
      scorer: ({ output }) => {
        const direct = output.toolNames.filter((name) => name !== CODE_RUN_TOOL);
        const ok = output.toolNames.length > 0 && direct.length === 0;

        return {
          score: ok ? 1 : 0,
          metadata: `calls=[${output.toolNames.join(", ") || "none"}]; scripts=[${output.scripts.map((script) => script.status).join(", ")}]`,
        };
      },
    },
    {
      name: `At most ${STEP_CEILING} model steps (prod: 43)`,
      scorer: ({ output }) => ({
        score: output.steps > 0 && output.steps <= STEP_CEILING ? 1 : 0,
        metadata: `steps=${output.steps}; host calls=${output.ledger.length}; failed=${output.ledger.filter((entry) => entry.kind !== "executed").length}`,
      }),
    },
    {
      name: `Peak context under ${PEAK_INPUT_TOKEN_CEILING} input tokens (prod: about 48k)`,
      scorer: ({ output }) => {
        const peak = Math.max(0, ...output.inputTokensPerStep);

        return {
          score: peak > 0 && peak <= PEAK_INPUT_TOKEN_CEILING ? 1 : 0,
          metadata: `input tokens per step=[${output.inputTokensPerStep.join(", ")}]`,
        };
      },
    },
    {
      // The gist needs each body, and only a script read should fetch them.
      name: "Scripts read the body of each open issue",
      scorer: ({ output }) => ({
        score: output.bodiesRead.length / OPEN_ISSUES.length,
        metadata: `${output.bodiesRead.length}/${OPEN_ISSUES.length} bodies read`,
      }),
    },
    {
      name: "The answer names each open issue",
      scorer: ({ output }) => {
        const named = issuesNamed(output.text);

        return {
          score: named / OPEN_ISSUES.length,
          metadata: `${named}/${OPEN_ISSUES.length} named; reply: ${output.text.slice(0, 200)}`,
        };
      },
    },
  ],
});
