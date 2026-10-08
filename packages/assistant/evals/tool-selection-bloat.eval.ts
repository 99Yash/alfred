import path from "node:path";
import { route } from "@alfred/ai";
import {
  INTEGRATION_ACTIONS,
  INTEGRATIONS,
  isLiveProviderSlug,
  LIVE_PROVIDER_SLUGS,
  parseIanaTimezone,
  type IntegrationSlug,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { type Tool, type ToolSet, generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "@alfred/assistant/execution/grounding";
import { registerBuiltinTools } from "../src/tool-runtime/builtin-tools";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// Does a large tool menu hurt tool selection? The same cases run under two menus that both hold
// the right tool: LEAN (system + the task's integration) and FULL (system + every live provider).
// The score gap is the cost ADR-0053 asked us to measure. One run per case, so read it roughly.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const builtinTools = registerBuiltinTools();

const NOW = new Date("2026-06-27T04:44:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

function buildToolSet(slugs: IntegrationSlug[]): ToolSet {
  const out: Record<string, Tool> = {};

  for (const slug of slugs) {
    for (const reg of builtinTools.listForIntegration(slug)) {
      // No `execute`, so the run stops at the first tool call.
      out[reg.name] = tool({ description: reg.description, inputSchema: reg.inputSchema });
    }
  }

  // SAFETY: ToolSet is an index-signature record; this map satisfies it by construction.
  return out as ToolSet;
}

function buildSummary(live: readonly LiveProviderSlug[]): string {
  if (live.length === 0) {
    return "You have no third-party integrations connected right now.";
  }

  const header =
    "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.";

  const lines = live.map((slug) => {
    const tools = INTEGRATION_ACTIONS[slug].map((a) => `${slug}.${a}`).join(", ");

    return `- ${tools} — ${INTEGRATIONS[slug].summaryBlurb}`;
  });

  return [header, ...lines].join("\n");
}

interface Case {
  input: string;
  expected: string;
  /** null = system tools only in LEAN. */
  home: LiveProviderSlug | null;
}

const CASES: Case[] = [
  // From real chat tasks.
  { input: "what's on my calendar tomorrow?", expected: "calendar.list_events", home: "calendar" },
  {
    input:
      "how many lines of code did PR #305 in 99Yash/alfred change? give me additions and deletions",
    expected: "github.get_pull_request",
    home: "github",
  },
  {
    input: "what PRs were merged on github in the last 30 hours?",
    expected: "github.search",
    home: "github",
  },
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
  // Integrations that are easy to confuse.
  {
    input: "what meetings do I have on Friday?",
    expected: "calendar.list_events",
    home: "calendar",
  },
  { input: "search my email for the invoice from Stripe", expected: "gmail.search", home: "gmail" },
  { input: "search my notion for the launch checklist", expected: "notion.search", home: "notion" },
  {
    input: "find the Q3 budget spreadsheet in my drive",
    expected: "drive.search_files",
    home: "drive",
  },
  { input: "list my vercel projects", expected: "vercel.list_projects", home: "vercel" },
  {
    input: "create a new google spreadsheet to track expenses",
    expected: "sheets.create_spreadsheet",
    home: "sheets",
  },
  {
    // A plain read, so the model has no reason to call read_user_context first.
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
  const live = slugs.filter(isLiveProviderSlug);

  const result = await generateText({
    model: route("standard").model(),
    instructions: buildChatSystemPrompt(
      formatDateGrounding(TIMEZONE, NOW),
      buildSummary(live),
      selfIdentityGrounding(),
    ),
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

    return runUnderMenu(input, ["system", ...LIVE_PROVIDER_SLUGS]);
  },
  scorers: scorers(),
});
