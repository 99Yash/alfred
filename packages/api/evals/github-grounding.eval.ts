import path from "node:path";
import { getChatModel } from "@alfred/ai";
import {
  githubGetPullRequestInput,
  githubSearchInput,
  githubSearchQueryIssues,
  sanitizeGithubSearchQuery,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// GROUND / #213 / ADR-0071: behavioral guard that the boss answers GitHub
// questions through the STRUCTURED fields (type + state + *WithinDays) instead
// of hand-writing GitHub search syntax into the free-form `query`, that it
// searches ISSUES when asked about issues, and that it does not BAIL or
// silently drop a requirement (the #222 LOC give-up). The prod bugs: the boss
// free-typed `merged-by:@me` (silent zero) and `closed:>` (non-deterministic
// counts), and on "total LOC across my PRs" it dropped the requirement instead
// of fanning out to get_pull_request. We expose the real github tools with no
// `execute` so the model stops at the first call, then assert on its args.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-24T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const SEARCH_TOOL = "github.search";
const GET_PR_TOOL = "github.get_pull_request";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail — search, read_message, send_draft — the user's email",
  "- calendar — list_events, create_event — the user's calendar",
  "- github — search, get_pull_request, get_issue — the user's GitHub issues and pull requests — connected as 99Yash",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

interface ExpectedGithubCall {
  type: "pr" | "issue" | "both";
  state?: "open" | "closed" | "merged" | "all";
  windowField?: "closedWithinDays" | "mergedWithinDays" | "createdWithinDays";
  windowValue?: number;
}

interface Case {
  input: string;
  expected: ExpectedGithubCall;
}

const CASES: Case[] = [
  {
    input: "how many PRs did i merge today",
    expected: { type: "pr", state: "merged", windowField: "mergedWithinDays", windowValue: 1 },
  },
  {
    input: "how many pull requests have i merged in the past week",
    expected: { type: "pr", state: "merged", windowField: "mergedWithinDays", windowValue: 7 },
  },
  {
    input: "how many PRs did i close in the past week",
    expected: { type: "pr", state: "closed", windowField: "closedWithinDays", windowValue: 7 },
  },
  {
    // ADR-0071: issues are searchable too — must not be forced through is:pr.
    input: "list my open github issues",
    expected: { type: "issue", state: "open" },
  },
];

function runFirstCall(input: string) {
  return generateText({
    model: getChatModel("standard"),
    system: SYSTEM,
    prompt: input,
    temperature: 0,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    // Both github tools, execute-less so the run halts on the first tool call
    // and we can inspect the args the model chose.
    tools: {
      [SEARCH_TOOL]: tool({
        description:
          "Search the user's GitHub issues and pull requests by author, state, type, and time window. Use the structured fields for type/author/state/recency; never hand-write those qualifiers into `query`.",
        inputSchema: githubSearchInput,
      }),
      [GET_PR_TOOL]: tool({
        description:
          "Fetch one pull request by owner/repo/number. Returns additions/deletions/changed_files that search cannot. Fan out over search hits to total lines changed.",
        inputSchema: githubGetPullRequestInput,
      }),
    },
  });
}

evalite<string, TaskOutput, ExpectedGithubCall>("Agent GitHub grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const result = await runFirstCall(input);
    const call = result.toolCalls.find((c) => c.toolName === SEARCH_TOOL) ?? result.toolCalls[0];
    return {
      toolName: call?.toolName ?? null,
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
    };
  },
  scorers: [
    {
      name: "Calls github.search",
      scorer: ({ output }) => ({
        score: output.toolName === SEARCH_TOOL ? 1 : 0,
        metadata:
          output.toolName === SEARCH_TOOL
            ? `args=${JSON.stringify(output.args)}`
            : `no github.search call; replied: ${output.text.slice(0, 200)}`,
      }),
    },
    {
      // The core regression: type matches, and recency comes from a structured
      // *WithinDays field with the specific field/value implied by the prompt.
      name: "Uses the expected structured filters",
      scorer: ({ output, expected }) => {
        const args = output.args ?? {};
        const typeOk = (args.type ?? "pr") === expected.type;
        const stateOk = expected.state === undefined || args.state === expected.state;
        const windowOk =
          expected.windowField === undefined || args[expected.windowField] === expected.windowValue;
        const ok = typeOk && stateOk && windowOk;
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `type:${expected.type}${expected.state ? ` state:${expected.state}` : ""}${expected.windowField ? ` ${expected.windowField}:${expected.windowValue}` : ""}`
            : `expected ${JSON.stringify(expected)}; args=${JSON.stringify(args)}`,
        };
      },
    },
    {
      // The free-form query (after sanitize-and-merge) must carry no invented
      // qualifiers (merged-by:) and no residual contradictions.
      name: "No invented or contradictory free-form qualifiers",
      scorer: ({ output }) => {
        const args = output.args ?? {};
        const { sanitized } = sanitizeGithubSearchQuery({
          query: typeof args.query === "string" ? args.query : undefined,
          state:
            args.state === "open" ||
            args.state === "closed" ||
            args.state === "merged" ||
            args.state === "all"
              ? args.state
              : undefined,
          type:
            args.type === "issue" || args.type === "pr" || args.type === "both"
              ? args.type
              : undefined,
          closedWithinDays:
            typeof args.closedWithinDays === "number" ? args.closedWithinDays : undefined,
          createdWithinDays:
            typeof args.createdWithinDays === "number" ? args.createdWithinDays : undefined,
          mergedWithinDays:
            typeof args.mergedWithinDays === "number" ? args.mergedWithinDays : undefined,
        });
        const issues = githubSearchQueryIssues(sanitized);
        return {
          score: issues.length === 0 ? 1 : 0,
          metadata: issues.length === 0 ? "clean query" : issues.join(" "),
        };
      },
    },
  ],
});

// ADR-0071 / #222: asked to total lines changed across PRs, the boss must NOT
// bail or silently drop the requirement — its first move is github.search to
// find the PRs (the diff stats come from get_pull_request fan-out afterward).
// With no execute the run stops after the first call, which is the point: we
// only assert it didn't give up at the gate.
evalite<string, TaskOutput, null>("Agent GitHub LOC — no give-up", {
  data: () => [
    { input: "how many lines of code did i change across my merged PRs this week", expected: null },
  ],
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const result = await runFirstCall(input);
    const call = result.toolCalls[0];
    return {
      toolName: call?.toolName ?? null,
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
    };
  },
  scorers: [
    {
      name: "Starts with a github tool call (no give-up, no asking for the repo)",
      scorer: ({ output }) => {
        const used = output.toolName === SEARCH_TOOL || output.toolName === GET_PR_TOOL;
        return {
          score: used ? 1 : 0,
          metadata: used
            ? `called ${output.toolName} with ${JSON.stringify(output.args)}`
            : `no github call; replied: ${output.text.slice(0, 240)}`,
        };
      },
    },
  ],
});
