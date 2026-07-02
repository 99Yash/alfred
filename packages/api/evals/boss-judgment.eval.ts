import path from "node:path";
import { getChatModel, getChatProviderOptions } from "@alfred/ai";
import {
  calendarListEventsInput,
  gmailSearchInput,
  readUserContextInput,
  webSearchInput,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { type Tool, generateText, stepCountIs, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import {
  awaitSubAgentInputSchema,
  spawnSubAgentInputSchema,
} from "../src/modules/agent/sub-agents";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// ADR-0077 amendment: behavioral guard for the boss charter. The old rulebook
// routed people questions inward (memory + Gmail) and never mentioned the live
// web; the 2026-07-02 Sakshi production thread re-asked for "more" three times
// and still made zero web_search calls, including on Deep/Opus. These cases test
// the source class the model reaches for, not a brittle exact path.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-07-02T07:30:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const READ_CONTEXT_TOOL = "system.read_user_context";
const WEB_SEARCH_TOOL = "system.web_search";
const SPAWN_SUB_AGENT_TOOL = "system.spawn_sub_agent";
const AWAIT_SUB_AGENT_TOOL = "system.await_sub_agent";
const GMAIL_SEARCH_TOOL = "gmail.search";
const CALENDAR_TOOL = "calendar.list_events";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- system.read_user_context — Alfred's stored memory about the user",
  "- system.web_search — live public web search",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

interface TaskOutput {
  toolNames: string[];
  first: string | null;
  text: string;
}

interface SourceCase {
  input: string;
  expected: "new_source" | "web" | "calendar";
}

const SOURCE_CASES: SourceCase[] = [
  {
    input:
      'Earlier in this thread, you answered "Sakshi Jindal appears in your calendar invites and email, but I only have thin internal context." The user now says: "find more about her".',
    expected: "new_source",
  },
  {
    input:
      'Earlier in this thread, you searched Alfred memory and Gmail and found only a couple of calendar-invite emails about Sakshi Jindal. The user now says: "can we know something more about her?"',
    expected: "new_source",
  },
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

function providerOptions(): Record<string, never> {
  // Mirrors the AlfredAgent boundary cast used in other evals.
  return getChatProviderOptions("standard") as unknown as Record<string, never>;
}

function toolSurface(): Record<string, Tool> {
  return {
    [READ_CONTEXT_TOOL]: tool({
      description:
        "Read Alfred's stored context about the user's profile, preferences, relationships, people, projects, and recent memory.",
      inputSchema: readUserContextInput,
    }),
    [WEB_SEARCH_TOOL]: tool({
      description:
        "Search the live public web for current facts, public background on people or companies, and information outside Alfred's memory or connected services.",
      inputSchema: webSearchInput,
    }),
    [SPAWN_SUB_AGENT_TOOL]: tool({
      description:
        "Spawn one focused sub-agent run for a multi-step investigation across memory, connected services, and the web.",
      inputSchema: spawnSubAgentInputSchema,
    }),
    [AWAIT_SUB_AGENT_TOOL]: tool({
      description: "Wait for a spawned sub-agent to finish and read its real result.",
      inputSchema: awaitSubAgentInputSchema,
    }),
    [GMAIL_SEARCH_TOOL]: tool({
      description:
        "Search Gmail messages. Each hit carries sender, subject, snippet, timestamp, ids, and a url.",
      inputSchema: gmailSearchInput,
    }),
    [CALENDAR_TOOL]: tool({
      description:
        "List Google Calendar events. Use this for calendar availability and event count questions.",
      inputSchema: calendarListEventsInput,
    }),
  };
}

async function runSourceChoice(input: string): Promise<TaskOutput> {
  const result = await generateText({
    model: getChatModel("standard"),
    system: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: providerOptions(),
    tools: toolSurface(),
  });
  const toolNames = result.toolCalls.map((call) => call.toolName);
  return { toolNames, first: toolNames[0] ?? null, text: result.text };
}

evalite<string, TaskOutput, SourceCase["expected"]>("Boss judgment — source ladder", {
  data: () => SOURCE_CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runSourceChoice(input);
    } catch (err) {
      return {
        toolNames: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Reaches the expected source class",
      scorer: ({ output, expected }) => {
        const reachedNewSource =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);
        const reachedWeb = output.toolNames.includes(WEB_SEARCH_TOOL);
        const reachedCalendar = output.toolNames.includes(CALENDAR_TOOL);
        const ok =
          expected === "new_source"
            ? reachedNewSource
            : expected === "web"
              ? reachedWeb
              : reachedCalendar;
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
        const ok =
          output.toolNames.includes(CALENDAR_TOOL) && !output.toolNames.includes(WEB_SEARCH_TOOL);
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

const clickUpSearchResultSchema = z.object({
  messages: z.array(
    z.object({
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
      authoredAt: z.string(),
      url: z.string(),
    }),
  ),
});

async function runClickUpAwareness(): Promise<TaskOutput> {
  const result = await generateText({
    model: getChatModel("standard"),
    system: SYSTEM,
    prompt:
      "Find more about Sakshi Jindal from what I have. If there is not much, tell me what would unlock more.",
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: providerOptions(),
    stopWhen: stepCountIs(3),
    tools: {
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored context about the user's people and projects.",
        inputSchema: readUserContextInput,
        execute: async () => ({
          profile: null,
          entities: [{ name: "Sakshi Jindal", summary: "Seen in recent work context only." }],
          facts: [],
          recentMemory: [],
        }),
      }),
      [GMAIL_SEARCH_TOOL]: tool({
        description:
          "Search Gmail messages. Each hit carries sender, subject, snippet, timestamp, ids, and a url.",
        inputSchema: gmailSearchInput,
        execute: async () =>
          clickUpSearchResultSchema.parse({
            messages: [
              {
                from: "ClickUp <notifications@clickup.com>",
                subject: "Sakshi Jindal mentioned you in a task",
                snippet:
                  "Sakshi Jindal commented on a ClickUp task. Open ClickUp to see the full task thread and project details.",
                authoredAt: "2026-07-01T10:15:00.000Z",
                url: "https://mail.google.com/mail/u/0/#all/clickup_sakshi_1",
              },
              {
                from: "ClickUp <notifications@clickup.com>",
                subject: "Task updated by Sakshi Jindal",
                snippet:
                  "A task involving Sakshi Jindal was updated in ClickUp. The details are in ClickUp.",
                authoredAt: "2026-07-01T09:00:00.000Z",
                url: "https://mail.google.com/mail/u/0/#all/clickup_sakshi_2",
              },
            ],
          }),
      }),
      [WEB_SEARCH_TOOL]: tool({
        description:
          "Search the live public web for current facts, public background on people or companies, and information outside Alfred's memory or connected services.",
        inputSchema: webSearchInput,
        execute: async () => ({
          results: [],
          summary: "No confident public result found for Sakshi Jindal in this work context.",
        }),
      }),
    },
  });
  const toolNames = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
  return { toolNames, first: toolNames[0] ?? null, text: result.text };
}

evalite<null, TaskOutput, null>("Boss judgment — names richer hidden source", {
  data: () => [{ input: null, expected: null }],
  task: async () => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runClickUpAwareness();
    } catch (err) {
      return {
        toolNames: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
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
  ],
});
