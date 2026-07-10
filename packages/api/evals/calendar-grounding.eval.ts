import path from "node:path";
import { getChatModel } from "@alfred/ai";
import { calendarListEventsInput } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// GROUND: behavioral guard that the boss answers relative calendar questions
// ("today" / "tomorrow" / "this week") through the STRUCTURED `window` /
// `partOfDay` fields instead of inventing a param name or hand-computing
// explicit RFC3339 bounds. The prod trace (run_wdtn451w1zp0): asked "what's on
// my calendar today" the boss invented `{timeframe:"today"}` (rejected — the
// real field is `window`), then bailed to explicit `timeMin/timeMax` bounds
// with a `+05:30` offset (rejected — the schema only accepted `Z`), landing the
// answer on the THIRD attempt. We expose the real calendar.list_events tool
// with no `execute` so the model stops at the first call, then assert its args.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-26T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const LIST_EVENTS_TOOL = "calendar.list_events";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message, gmail.send_draft — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- github.search, github.get_pull_request, github.get_issue — the user's GitHub issues and pull requests — connected as 99Yash",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

// The advertised parameters (from the model-facing JSON schema). The runtime
// schema also tolerates window-key synonyms (`timeframe`/`range`/…), but the
// goal we measure here is that the model uses the real `window` — a synonym
// still counts as a grounding miss even though the tool would accept it.
const ADVERTISED = z.toJSONSchema(calendarListEventsInput, { io: "input" }) as {
  properties?: Record<string, unknown>;
};
const ACCEPTED_PARAMS = new Set(Object.keys(ADVERTISED.properties ?? {}));

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

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
    // The exact prod fumble: relative "today" must use window, not invented
    // params and not hand-computed bounds.
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
    model: getChatModel("standard"),
    instructions: SYSTEM,
    prompt: input,
    temperature: 0,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    // The real calendar tool, execute-less so the run halts on the first tool
    // call and we can inspect the args the model chose.
    tools: {
      [LIST_EVENTS_TOOL]: tool({
        description:
          "List Google Calendar events. Prefer the relative window fields for today/tomorrow/next-week questions; use explicit RFC3339 bounds only when the user gave exact dates or times.",
        inputSchema: calendarListEventsInput,
      }),
    },
  });
}

evalite<string, TaskOutput, ExpectedCalendarCall>("Agent calendar grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    const result = await runFirstCall(input);
    const call =
      result.toolCalls.find((c) => c.toolName === LIST_EVENTS_TOOL) ?? result.toolCalls[0];
    return {
      toolName: call?.toolName ?? null,
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
      // The core regression: only real schema params (no invented `timeframe`).
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
      // Relative questions resolve through the structured window/partOfDay
      // fields, not hand-computed timeMin/timeMax bounds.
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
