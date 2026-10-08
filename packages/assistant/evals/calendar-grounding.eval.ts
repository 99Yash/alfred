import path from "node:path";
import { route } from "@alfred/ai";
import { calendarListEventsInput, parseIanaTimezone } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { formatRuntimeTimeGrounding } from "@alfred/assistant/execution/grounding";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import type { GroundingTaskOutput } from "./lib/grounding";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// The boss must answer "today" or "this week" with the `window` / `partOfDay` fields.
// In prod (run_wdtn451w1zp0) it invented `timeframe`, then hand-computed bounds, and took three tries.
// The tool has no `execute`, so the run stops at the first call and we check its args.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-26T04:44:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const LIST_EVENTS_TOOL = "calendar.list_events";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message, gmail.send_draft — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- github.search, github.get_pull_request, github.get_issue — the user's GitHub issues and pull requests — connected as 99Yash",
].join("\n");

// Like prod: the system prompt has no date. "Now" comes from the runtime line in runFirstCall (#410).
const SYSTEM = buildChatSystemPrompt("", CONNECTED_SUMMARY, selfIdentityGrounding());

// The runtime schema accepts synonyms like `timeframe`, but using one still counts as a miss.
// SAFETY: reads only the top-level `properties` of the emitted JSON Schema.
const ADVERTISED = z.toJSONSchema(calendarListEventsInput, { io: "input" }) as {
  properties?: Record<string, unknown>;
};

const ACCEPTED_PARAMS = new Set(Object.keys(ADVERTISED.properties ?? {}));

interface ExpectedCalendarCall {
  window?: "today" | "tomorrow" | "next_7_days";
  partOfDay?: "full_day" | "morning" | "afternoon" | "evening";
}

interface Case {
  input: string;
  expected: ExpectedCalendarCall;
}

const CASES: Case[] = [
  {
    // The exact prod failure.
    input: "what's on my calendar today?",
    expected: { window: "today" },
  },
  {
    input: "what do i have tomorrow?",
    expected: { window: "tomorrow" },
  },
  {
    input: "am i free tomorrow morning?",
    expected: { window: "tomorrow", partOfDay: "morning" },
  },
  {
    input: "what's on my calendar this week?",
    expected: { window: "next_7_days" },
  },
];

function runFirstCall(input: string) {
  return generateText({
    model: route("standard").model(),
    instructions: SYSTEM,
    messages: [
      { role: "assistant", content: formatRuntimeTimeGrounding(TIMEZONE, NOW) },
      { role: "user", content: input },
    ],
    temperature: 0,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    tools: {
      [LIST_EVENTS_TOOL]: tool({
        description:
          "List Google Calendar events. Prefer the relative window fields for today/tomorrow/next-week questions; use explicit RFC3339 bounds only when the user gave exact dates or times.",
        inputSchema: calendarListEventsInput,
      }),
    },
  });
}

evalite<string, GroundingTaskOutput, ExpectedCalendarCall>("Agent calendar grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const result = await runFirstCall(input);

    const call =
      result.toolCalls.find((c) => c.toolName === LIST_EVENTS_TOOL) ?? result.toolCalls[0];

    return {
      toolName: call?.toolName ?? null,
      // SAFETY: diagnostic view of the tool-call input; `??` covers absence.
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
    };
  },
  scorers: [
    {
      name: "Calls calendar.list_events",
      scorer: ({ output }) => ({
        score: output.toolName === LIST_EVENTS_TOOL ? 1 : 0,
        metadata:
          output.toolName === LIST_EVENTS_TOOL
            ? `args=${JSON.stringify(output.args)}`
            : `no calendar.list_events call; replied: ${output.text.slice(0, 200)}`,
      }),
    },
    {
      name: "No invented parameters",
      scorer: ({ output }) => {
        const args = output.args ?? {};
        const invented = Object.keys(args).filter((k) => !ACCEPTED_PARAMS.has(k));

        return {
          score: invented.length === 0 ? 1 : 0,
          metadata:
            invented.length === 0
              ? "only schema params"
              : `invented: ${invented.join(", ")} (accepts: ${[...ACCEPTED_PARAMS].join(", ")})`,
        };
      },
    },
    {
      name: "Uses the relative window field",
      scorer: ({ output, expected }) => {
        const args = output.args ?? {};
        const windowOk = args.window === expected.window;
        const partOk = expected.partOfDay === undefined || args.partOfDay === expected.partOfDay;
        const noBounds = args.timeMin === undefined && args.timeMax === undefined;
        const ok = windowOk && partOk && noBounds;

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `window:${expected.window}${expected.partOfDay ? ` partOfDay:${expected.partOfDay}` : ""}`
            : `expected window:${expected.window}${expected.partOfDay ? ` partOfDay:${expected.partOfDay}` : ""}; args=${JSON.stringify(args)}`,
        };
      },
    },
  ],
});
