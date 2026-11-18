import { readFileSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "@alfred/contracts";
import type { Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import type {
  McpNegotiatedServer,
  McpProtocolCallResult,
  McpProtocolClient,
  McpProtocolPage,
} from "../../src/connections/mcp/protocol";

// A synthetic GitHub repository behind the captured GitHub MCP read-only catalog (2026-11-08,
// 28 descriptors as the server sent them). The content is synthetic, so no private data is in the repo. The
// result shapes follow the GitHub MCP server: `list_issues` returns each body when the call
// does not name `fields`, as the real server does. No real issue result was captured.

// A made-up repo, not the owner's public `99Yash/alfred`. When a GitHub read fails, the model
// reads the web. A real repo then gives it real issues that contradict the planted facts (the
// 2026-11-18 run: two single-lookup answers described the real PR #1201).
export const REPO_OWNER = "quillmoor-labs";

export const REPO_NAME = "tidewater";

const descriptorSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  inputSchema: z.looseObject({ type: z.literal("object") }),
});

/** The captured catalog, as the connection lists it. */
export const GITHUB_CATALOG: Tool[] = z
  .array(descriptorSchema)
  .parse(
    JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../fixtures/github-mcp-catalog.json"),
        "utf8",
      ),
    ),
  );

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

const VERBS = ["fold", "pin", "drain", "seal", "clamp", "merge", "route"] as const;

const NOUNS = ["Cursor", "Lease", "Ledger", "Shard", "Window", "Token"] as const;

/**
 * The planted fact of an issue: the function its body names as the root cause. The name has
 * no paraphrase, so an answer that gives the cause states it as written.
 */
function rootCauseOf(index: number): string {
  return `${VERBS[index % VERBS.length]}${NOUNS[index % NOUNS.length]}${index + 11}`;
}

/** Repeated in each body, so a direct read of every body costs what the prod run paid. */
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
  state: "OPEN" | "CLOSED";
  label: string;
  body: string;
  comments: CommentFixture[];
  createdAt: string;
}

interface CommentFixture {
  author: string;
  body: string;
}

/** The issue with the most comments, for the dependent-reads case. */
const MOST_DISCUSSED_INDEX = 16;

/** The planted fact of the last comment on the most discussed issue. */
export const LAST_COMMENT_FACT = "kestrel-4417";

function commentsOf(index: number): CommentFixture[] {
  const count = index === MOST_DISCUSSED_INDEX ? 14 : (index * 5) % 9;

  return Array.from({ length: count }, (_, position) => ({
    author: position % 2 === 0 ? REPO_OWNER : "reviewer-bot",
    body:
      index === MOST_DISCUSSED_INDEX && position === count - 1
        ? `Fixed on the staging branch. The poke damper ships behind the rollout key ${LAST_COMMENT_FACT}.`
        : `Seen again on run ${index * 100 + position}. Same trace as above.`,
  }));
}

export const OPEN_ISSUES: readonly IssueFixture[] = ISSUE_TITLES.map((title, index) => ({
  number: 1180 + index * 3,
  title,
  state: "OPEN",
  label: title.slice(0, title.indexOf(":")).toLowerCase(),
  body: `${title}.\n\nRoot cause: \`${rootCauseOf(index)}\` returns before the commit.\n\n${ISSUE_CONTEXT}`,
  comments: commentsOf(index),
  createdAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
}));

/** The root cause that each open issue plants, in issue order. */
export const OPEN_ISSUE_ROOT_CAUSES: readonly string[] = ISSUE_TITLES.map((_, index) =>
  rootCauseOf(index),
);

export const MOST_DISCUSSED_ISSUE = OPEN_ISSUES[MOST_DISCUSSED_INDEX] ?? OPEN_ISSUES[0];

/** The planted fact of the large single result: the first frame that threw. */
export const CRASH_LOG_FACT = "reconcileQuorumShard";

const CRASH_LOG_LINES = 1_400;

/** About 140 KB. The first throw is near the middle, so a cut at either end loses it. */
function crashLog(): string {
  const lines: string[] = [];

  for (let line = 0; line < CRASH_LOG_LINES; line += 1) {
    if (line === Math.floor(CRASH_LOG_LINES * 0.55)) {
      lines.push(
        `2026-11-07T02:14:${String(line % 60).padStart(2, "0")}Z FIRST THROW: TypeError: cannot read 'epoch' of undefined`,
        `    at ${CRASH_LOG_FACT} (packages/sync/src/quorum.ts:212:19)`,
        "    at drainShardQueue (packages/sync/src/queue.ts:88:7)",
      );
      continue;
    }

    lines.push(
      `2026-11-07T02:${String(Math.floor(line / 60) % 60).padStart(2, "0")}:${String(line % 60).padStart(2, "0")}Z worker=sync-${line % 4} shard=${line % 32} heartbeat ok lag_ms=${(line * 37) % 900} queue_depth=${(line * 13) % 400}`,
    );
  }

  return lines.join("\n");
}

export const CRASH_LOG_ISSUE: IssueFixture = {
  number: 1299,
  title: "Crash log: the sync worker exits during the nightly backfill",
  state: "CLOSED",
  label: "sync",
  body: `The sync worker exited at 02:14 UTC. The full log is below.\n\n\`\`\`\n${crashLog()}\n\`\`\``,
  comments: [],
  createdAt: "2026-11-07T03:00:00.000Z",
};

const ALL_ISSUES: readonly IssueFixture[] = [...OPEN_ISSUES, CRASH_LOG_ISSUE];

/** The file that the gated read asks for, and its two planted facts. */
export const SETUP_FILE_PATH = "docs/setup.md";

export const SETUP_FILE_FACTS = ["26.13.1", "amber-falcon-29"] as const;

const SETUP_FILE = [
  "# Setup",
  "",
  `Alfred needs Node ${SETUP_FILE_FACTS[0]} and pnpm 11.`,
  "",
  "1. Copy `apps/server/.env.example` to `apps/server/.env`.",
  `2. Ask the owner for the local setup key. Its current value is \`${SETUP_FILE_FACTS[1]}\`.`,
  "3. Run `pnpm install`, then `pnpm dev`.",
].join("\n");

function issueUrl(issue: IssueFixture): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}`;
}

/** One issue in the shape of the GitHub MCP server's minimal issue. */
function issueJson(issue: IssueFixture): JsonObject {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: REPO_OWNER },
    labels: [issue.label],
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    html_url: issueUrl(issue),
  };
}

function pickFields(issue: JsonObject, fields: readonly string[] | undefined): JsonObject {
  if (fields === undefined || fields.length === 0) return issue;

  return Object.fromEntries(Object.entries(issue).filter(([key]) => fields.includes(key)));
}

function jsonResult(payload: unknown): McpProtocolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(text: string): McpProtocolCallResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const repoArgs = z.object({ owner: z.string(), repo: z.string() });

function isRepo(args: unknown): boolean {
  const parsed = repoArgs.safeParse(args);

  return (
    parsed.success &&
    parsed.data.owner.toLowerCase() === REPO_OWNER.toLowerCase() &&
    parsed.data.repo.toLowerCase() === REPO_NAME
  );
}

const listIssuesArgs = z.object({
  state: z.enum(["OPEN", "CLOSED"]).optional(),
  perPage: z.number().optional(),
  after: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

const DEFAULT_PAGE_SIZE = 30;

function listIssues(args: JsonObject): McpProtocolCallResult {
  if (!isRepo(args)) return toolError("failed to list issues: Could not resolve to a Repository");
  const parsed = listIssuesArgs.parse(args);

  // Like the real server, no `state` returns both open and closed issues.
  const issues = ALL_ISSUES.filter((issue) => !parsed.state || issue.state === parsed.state);
  const start = parsed.after ? Number(parsed.after) : 0;
  const page = issues.slice(start, start + (parsed.perPage ?? DEFAULT_PAGE_SIZE));
  const end = start + page.length;

  return jsonResult({
    issues: page.map((issue) => pickFields(issueJson(issue), parsed.fields)),
    pageInfo: {
      hasNextPage: end < issues.length,
      hasPreviousPage: start > 0,
      startCursor: String(start),
      endCursor: String(end),
    },
    totalCount: issues.length,
  });
}

const searchIssuesArgs = z.object({
  query: z.string(),
  perPage: z.number().optional(),
  page: z.number().optional(),
});

/** Enough of the search grammar for this repo: `is:open`, `is:closed`, and words in the title. */
function searchIssues(args: JsonObject): McpProtocolCallResult {
  const parsed = searchIssuesArgs.parse(args);
  const terms = parsed.query.toLowerCase().split(/\s+/).filter(Boolean);
  const words = terms.filter((term) => !term.includes(":"));

  const items = ALL_ISSUES.filter((issue) => {
    if (terms.includes("is:open") && issue.state !== "OPEN") return false;

    if (terms.includes("is:closed") && issue.state !== "CLOSED") return false;

    return words.every((word) => issue.title.toLowerCase().includes(word));
  });

  const perPage = parsed.perPage ?? DEFAULT_PAGE_SIZE;
  const start = ((parsed.page ?? 1) - 1) * perPage;

  return jsonResult({
    total_count: items.length,
    incomplete_results: false,
    items: items.slice(start, start + perPage).map(issueJson),
  });
}

const issueReadArgs = z.object({
  method: z.enum(["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"]),
  issue_number: z.number(),
});

function readIssue(args: JsonObject): McpProtocolCallResult {
  const parsed = issueReadArgs.parse(args);
  const issue = ALL_ISSUES.find((candidate) => candidate.number === parsed.issue_number);

  if (!isRepo(args) || !issue) return toolError("failed to get issue: GET 404 Not Found");

  switch (parsed.method) {
    case "get":
      return jsonResult({ ...issueJson(issue), has_parent: false, has_children: false });
    case "get_comments":
      return jsonResult(
        issue.comments.map((comment, position) => ({
          id: issue.number * 1000 + position,
          user: { login: comment.author },
          body: comment.body,
          created_at: new Date(Date.parse(issue.createdAt) + (position + 1) * 3_600_000),
        })),
      );
    case "get_labels":
      return jsonResult([{ name: issue.label }]);
    case "get_sub_issues":
      return jsonResult([]);
    case "get_parent":
      return toolError("this issue has no parent");
  }
}

function getFileContents(args: JsonObject): McpProtocolCallResult {
  const filePath = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";

  if (!isRepo(args) || filePath !== SETUP_FILE_PATH) {
    return toolError(`failed to get file contents: GET 404 Not Found (${filePath || "/"})`);
  }

  return {
    content: [
      { type: "text", text: "successfully downloaded text file (SHA: 5d1e0c7)" },
      {
        type: "resource",
        resource: {
          uri: `repo://${REPO_OWNER}/${REPO_NAME}/contents/${SETUP_FILE_PATH}`,
          mimeType: "text/markdown",
          text: SETUP_FILE,
        },
      },
    ],
  };
}

/** The GitHub server for one eval connection: the captured catalog and the synthetic repo. */
export class FakeGithubProtocol implements McpProtocolClient {
  /** The remote calls, in order. */
  readonly calls: string[] = [];

  async connect(): Promise<McpNegotiatedServer> {
    return {
      protocolEra: "pre_2026_07_28",
      protocolVersion: "2025-11-25",
      mirrorsParamHeaders: false,
      serverName: "github-mcp-server",
      serverVersion: "eval",
      hasTools: true,
      toolsListChanged: false,
    };
  }

  async close(): Promise<void> {}

  async listTools(): Promise<McpProtocolPage> {
    return { tools: GITHUB_CATALOG, ttlMs: 0, cacheScope: "private" };
  }

  async callTool(tool: Tool, args: JsonObject): Promise<McpProtocolCallResult> {
    this.calls.push(tool.name);

    switch (tool.name) {
      case "list_issues":
        return listIssues(args);
      case "search_issues":
        return searchIssues(args);
      case "issue_read":
        return readIssue(args);
      case "get_file_contents":
        return getFileContents(args);
      case "get_me":
        return jsonResult({ login: REPO_OWNER, name: "Owner" });
      default:
        return toolError(`${tool.name} has no data in this eval`);
    }
  }

  onToolsChanged(): void {}

  onConnectionUnhealthy(): void {}
}
