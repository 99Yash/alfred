import path from "node:path";
import { getChatModel } from "@alfred/ai";
import {
  INTEGRATION_ACTIONS,
  type IntegrationSlug,
  type LoadableIntegrationSlug,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { type Tool, type ToolSet, generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { listToolsForIntegration, registerBuiltinTools } from "../src/modules/tools";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// LESSON 03 / context-purity experiment: does a bloated tool menu degrade the
// boss's tool SELECTION? We run the same realistic tasks through Sonnet 4.6
// (getChatModel("standard"), the real chat driver) under two menus that BOTH
// contain the correct tool:
//   LEAN  = system tools + only the task's home integration  (~17-21 tools)
//   FULL  = system tools + all 10 connected integrations     (~49 tools)
// Identical cases, identical scorer. The gap between the two suites' aggregate
// scores is the bloat cost — the number ADR-0053 said to measure before
// reviving lazy/scoped loading. Cases are seeded from REAL dev-DB chat tasks
// plus deliberately cross-integration-confusable ones (notion/gmail/drive
// search; railway↔vercel deploy; sheets↔drive; web_search vs *.search).
//
// Caveat: scoping changes both the declared schemas AND the connected-summary
// catalog text together (that's what real scoping would do), so this measures
// the decision-relevant effect, not a single isolated variable. n is small
// (one run/case) — read a gap as "worth pursuing", not a precise percentage.
//
// Run: `pnpm --filter @alfred/api eval` (needs apps/server/.env: ANTHROPIC_API_KEY).

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

registerBuiltinTools();

const NOW = new Date("2026-06-27T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

// The 10 connected integrations with a non-empty action surface (slack, linear,
// imessage are empty stubs). This is the realistic FULL menu for this user.
const FULL_INTEGRATIONS: LoadableIntegrationSlug[] = [
  "gmail",
  "calendar",
  "drive",
  "docs",
  "sheets",
  "slides",
  "github",
  "notion",
  "railway",
  "vercel",
];

const BLURB: Record<LoadableIntegrationSlug, string> = {
  gmail: "the user's email",
  calendar: "the user's calendar",
  drive: "the user's Google Drive files",
  docs: "the user's Google Docs",
  sheets: "the user's Google Sheets",
  slides: "the user's Google Slides",
  github: "the user's GitHub issues and pull requests",
  notion: "the user's Notion workspace",
  railway: "the user's Railway projects and deployments",
  vercel: "the user's Vercel projects and deployments",
  slack: "",
  linear: "",
  imessage: "",
};

/** Build the SDK tool set for a set of slugs — mirrors `resolveSdkTools`. */
function buildToolSet(slugs: IntegrationSlug[]): ToolSet {
  const out: Record<string, Tool> = {};
  for (const slug of slugs) {
    for (const reg of listToolsForIntegration(slug)) {
      // No `execute` → the run halts on the first tool call so we can inspect
      // which tool the model chose (same trick as github-grounding.eval.ts).
      out[reg.name] = tool({ description: reg.description, inputSchema: reg.inputSchema });
    }
  }
  return out as ToolSet;
}

/** Build the connected-summary catalog text for the loadable slugs in scope. */
function buildSummary(loadable: LoadableIntegrationSlug[]): string {
  if (loadable.length === 0) {
    return "You have no third-party integrations connected right now.";
  }
  const header =
    "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.";
  const lines = loadable.map((slug) => {
    const tools = INTEGRATION_ACTIONS[slug].map((a) => `${slug}.${a}`).join(", ");
    return `- ${tools} — ${BLURB[slug]}`;
  });
  return [header, ...lines].join("\n");
}

interface Case {
  input: string;
  expected: string;
  /** Loadable integration to include in the LEAN menu; null = system-only LEAN. */
  home: LoadableIntegrationSlug | null;
}

const CASES: Case[] = [
  // --- seeded from real dev-DB chat tasks ---
  { input: "what's on my calendar tomorrow?", expected: "calendar.list_events", home: "calendar" },
  {
    input: "how many lines of code did PR #305 in 99Yash/alfred change? give me additions and deletions",
    expected: "github.get_pull_request",
    home: "github",
  },
  { input: "what PRs were merged on github in the last 30 hours?", expected: "github.search", home: "github" },
  { input: "list my open github issues", expected: "github.search", home: "github" },
  {
    input: "search the web for today's top AI news and give me one headline",
    expected: "system.web_search",
    home: null,
  },
  {
    input: "read https://example.com and tell me the page title and a one-line summary",
    expected: "system.fetch_url",
    home: null,
  },
  // --- cross-integration confusables (where a bloated menu should bite) ---
  { input: "what meetings do I have on Friday?", expected: "calendar.list_events", home: "calendar" },
  { input: "search my email for the invoice from Stripe", expected: "gmail.search", home: "gmail" },
  { input: "search my notion for the launch checklist", expected: "notion.search", home: "notion" },
  { input: "find the Q3 budget spreadsheet in my drive", expected: "drive.search_files", home: "drive" },
  // NOTE: list_deployments/redeploy need a projectId first, so the correct
  // first move is list_projects — expectations target that, not the action that
  // can only run after an id lookup (avoids a false "miss" unrelated to bloat).
  { input: "what railway projects do I have?", expected: "railway.list_projects", home: "railway" },
  { input: "list my vercel projects", expected: "vercel.list_projects", home: "vercel" },
  {
    input: "create a new google spreadsheet to track expenses",
    expected: "sheets.create_spreadsheet",
    home: "sheets",
  },
  {
    // A read (get) needs no prep context, so it cleanly tests slides selection
    // without the model reasonably reaching for read_user_context first.
    input: "get the google slides presentation with id pres_1AbC and summarize it",
    expected: "slides.get_presentation",
    home: "slides",
  },
  {
    input: "open the google doc with id 1AbC and give me a summary of it",
    expected: "docs.get_document",
    home: "docs",
  },
];

interface TaskOutput {
  toolNames: string[];
  first: string | null;
  text: string;
}

async function runUnderMenu(input: string, slugs: IntegrationSlug[]): Promise<TaskOutput> {
  const loadable = slugs.filter((s): s is LoadableIntegrationSlug => s !== "system");
  const result = await generateText({
    model: getChatModel("standard"),
    system: buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), buildSummary(loadable)),
    prompt: input,
    temperature: 0,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    tools: buildToolSet(slugs),
  });
  const toolNames = result.toolCalls.map((c) => c.toolName);
  return { toolNames, first: toolNames[0] ?? null, text: result.text };
}

function scorers() {
  return [
    {
      name: "Calls the expected tool",
      scorer: ({ output, expected }: { output: TaskOutput; expected: string }) => {
        const hit = output.toolNames.includes(expected);
        return {
          score: hit ? 1 : 0,
          metadata: hit
            ? `called ${expected}`
            : `expected ${expected}; got [${output.toolNames.join(", ") || "no tool"}]${output.text ? ` — replied: ${output.text.slice(0, 140)}` : ""}`,
        };
      },
    },
    {
      name: "Expected tool is the FIRST call",
      scorer: ({ output, expected }: { output: TaskOutput; expected: string }) => ({
        score: output.first === expected ? 1 : 0,
        metadata: `first=${output.first ?? "none"} expected=${expected}`,
      }),
    },
  ];
}

evalite<string, TaskOutput, string>("Tool selection — LEAN menu (system + home)", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const c = CASES.find((x) => x.input === input);
    const slugs: IntegrationSlug[] = c?.home ? ["system", c.home] : ["system"];
    return runUnderMenu(input, slugs);
  },
  scorers: scorers(),
});

evalite<string, TaskOutput, string>("Tool selection — FULL menu (system + all 10)", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    return runUnderMenu(input, ["system", ...FULL_INTEGRATIONS]);
  },
  scorers: scorers(),
});
