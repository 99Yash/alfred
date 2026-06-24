import path from "node:path";
import { getChatModel } from "@alfred/ai";
import { pullRequestQueryIssues, searchPullRequestsInput } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// GROUND / #213: behavioral guard that the boss answers time-relative GitHub
// questions through the STRUCTURED fields (state + *WithinDays) instead of
// hand-writing GitHub search syntax into the free-form `query`. The prod bug:
// the boss free-typed `merged-by:@me` (a qualifier GitHub doesn't have, so it
// silently returned 0) and `closed:>` vs `closed:>=` (non-deterministic 19 vs
// 23 counts). We expose the real github tool with no `execute` so the model
// stops at the call, then assert deterministically on its args.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-24T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const GITHUB_TOOL = "github.search_pull_requests";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail — search, read_message, send_draft — the user's email",
  "- calendar — list_events, create_event — the user's calendar",
  "- github — search_pull_requests — the user's GitHub pull requests",
].join("\n");

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

interface ExpectedGithubCall {
  state: "closed" | "merged";
  windowField: "closedWithinDays" | "mergedWithinDays";
  windowValue: number;
}

interface Case {
  input: string;
  expected: ExpectedGithubCall;
}

const CASES: Case[] = [
  {
    input: "how many PRs did i merge today",
    expected: { state: "merged", windowField: "mergedWithinDays", windowValue: 1 },
  },
  {
    input: "how many pull requests have i merged in the past week",
    expected: { state: "merged", windowField: "mergedWithinDays", windowValue: 7 },
  },
  {
    input: "how many PRs did i close in the past week",
    expected: { state: "closed", windowField: "closedWithinDays", windowValue: 7 },
  },
];

evalite<string, TaskOutput, ExpectedGithubCall>("Agent GitHub grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const system = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);
    const result = await generateText({
      model: getChatModel("standard"),
      system,
      prompt: input,
      temperature: 0,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      tools: {
        [GITHUB_TOOL]: tool({
          description:
            "Search the user's GitHub pull requests by author, state, and time window. Use the structured fields for author/state/recency; never hand-write those qualifiers into `query`.",
          inputSchema: searchPullRequestsInput,
        }),
      },
    });
    const call = result.toolCalls.find((c) => c.toolName === GITHUB_TOOL) ?? result.toolCalls[0];
    return {
      toolName: call?.toolName ?? null,
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
    };
  },
  scorers: [
    {
      name: "Calls the github tool",
      scorer: ({ output }) => ({
        score: output.toolName === GITHUB_TOOL ? 1 : 0,
        metadata:
          output.toolName === GITHUB_TOOL
            ? `args=${JSON.stringify(output.args)}`
            : `no github call; replied: ${output.text.slice(0, 200)}`,
      }),
    },
    {
      // The core regression: recency must come from a structured *WithinDays
      // field, and it must be the specific field/value implied by the prompt.
      name: "Uses the expected structured filters",
      scorer: ({ output, expected }) => {
        const args = output.args ?? {};
        const usesExpected =
          args.state === expected.state && args[expected.windowField] === expected.windowValue;
        return {
          score: usesExpected ? 1 : 0,
          metadata: usesExpected
            ? `${expected.state} + ${expected.windowField}:${expected.windowValue}`
            : `expected ${expected.state} + ${expected.windowField}:${expected.windowValue}; args=${JSON.stringify(args)}`,
        };
      },
    },
    {
      // The free-form query (if any) must be clean — no invented qualifiers
      // (merged-by:) and no structured-field collisions.
      name: "No invented or colliding free-form qualifiers",
      scorer: ({ output }) => {
        const args = output.args ?? {};
        const issues = pullRequestQueryIssues({
          query: typeof args.query === "string" ? args.query : undefined,
          state:
            args.state === "open" ||
            args.state === "closed" ||
            args.state === "merged" ||
            args.state === "all"
              ? args.state
              : undefined,
          closedWithinDays:
            typeof args.closedWithinDays === "number" ? args.closedWithinDays : undefined,
          createdWithinDays:
            typeof args.createdWithinDays === "number" ? args.createdWithinDays : undefined,
          mergedWithinDays:
            typeof args.mergedWithinDays === "number" ? args.mergedWithinDays : undefined,
        });
        return {
          score: issues.length === 0 ? 1 : 0,
          metadata: issues.length === 0 ? "clean query" : issues.join(" "),
        };
      },
    },
  ],
});
