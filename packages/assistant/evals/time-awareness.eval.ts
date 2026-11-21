import path from "node:path";
import { route } from "@alfred/ai";
import { mcpCallModelInput, mcpToolSearchInputSchema, parseIanaTimezone } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool, type ModelMessage } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import type { ChatReadPath } from "@alfred/assistant/chat/chat-turn-state";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { currentTimeSnapshot, systemTools } from "../src/tool-runtime/internal/tools/system";
import { userMessageAt } from "./lib/grounding";

// ADR-0130 decision 7, amendment (e): each user message ends with its send time, a short
// `<sent>` stamp or a full `<time_note>` after a pause. The model must answer from the time on the
// newest message, so a past event is never "left" or "next". The eval gives `system.current_time`
// from the start. In prod the tool is lazy, and a call loads it for the next step. The score reads
// the answer, not the call.
// Run with apps/server/.env populated: `pnpm exec evalite run evals/time-awareness.eval.ts`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

// The morning messages of Wed 10 June 2026, IST: 09:10 (full note), 09:18, and 09:24 (stamps).
const MORNING = [
  new Date("2026-06-10T03:40:00Z"),
  new Date("2026-06-10T03:48:00Z"),
  new Date("2026-06-10T03:54:00Z"),
] as const;

/** When the question comes, and what is still ahead on the calendar at that time. */
interface AskedAt {
  label: string;
  at: Date;
  /** Event names (as regexes) still ahead, in order. */
  ahead: RegExp[];
  /** Event names that already ended. */
  past: RegExp[];
  /** The wait until the next event, as the model may write it. */
  untilNext: RegExp;
}

const STANDUP = /standup/i;

const VENDOR = /vendor/i;

const SAM = /\bSam\b/;

const DINNER = /dinner|\bAna\b/i;

const ASKED_AT: AskedAt[] = [
  // 28 minutes after the last message: a `<sent>09:52</sent>` stamp. The standup ended at 09:45.
  {
    label: "stamp 09:52",
    at: new Date("2026-06-10T04:22:00Z"),
    ahead: [VENDOR, SAM, DINNER],
    past: [STANDUP],
    // "About 4 hours" is correct to the nearest hour. From 09:24, the wait would be 4 h 36 min.
    untilNext: /4\s*(h|hours?)\b[^.]{0,8}\b8\s*min|about 4 hours/i,
  },
  // Hours after the last message: a full time note at 17:50.
  {
    label: "note 17:50",
    at: new Date("2026-06-10T12:20:00Z"),
    ahead: [SAM, DINNER],
    past: [STANDUP, VENDOR],
    untilNext: /\b40\s*min/i,
  },
];

const EVAL_TIMEOUT_MS = 60_000;

const CURRENT_TIME_TOOL = "system.current_time";

const CALENDAR_CONNECTION = {
  id: "mcp_conn_google_calendar",
  instanceKey: "calendar",
  label: "Google Calendar",
};

const CALENDAR_LIST_REMOTE = "list_events";

const CALENDAR_LIST_HIT = {
  ref: { kind: "mcp", connectionId: CALENDAR_CONNECTION.id, remoteName: CALENDAR_LIST_REMOTE },
  namespace: CALENDAR_CONNECTION.instanceKey,
  connection: CALENDAR_CONNECTION,
  description: "List the events on the user's calendar in a time range.",
};

// The whole day, so the model must compare each event with the current time to find what is left.
const TODAY_EVENTS = {
  events: [
    {
      summary: "Team standup",
      start: "2026-06-10T09:30:00+05:30",
      end: "2026-06-10T09:45:00+05:30",
    },
    {
      summary: "Vendor review",
      start: "2026-06-10T14:00:00+05:30",
      end: "2026-06-10T15:00:00+05:30",
    },
    {
      summary: "1:1 with Sam",
      start: "2026-06-10T18:30:00+05:30",
      end: "2026-06-10T19:00:00+05:30",
    },
    {
      summary: "Dinner with Ana",
      start: "2026-06-10T20:00:00+05:30",
      end: "2026-06-10T21:30:00+05:30",
    },
  ],
};

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  `- ${JSON.stringify(CALENDAR_CONNECTION.label)} MCP server (connectionId ${CALENDAR_CONNECTION.id}) — 9 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
].join("\n");

const currentTimeDescription = systemTools.find((t) => t.name === CURRENT_TIME_TOOL)?.description;

/** A morning with the user: the first message gets the full note, the next two get stamps. */
const HISTORY: ModelMessage[] = [
  {
    role: "user",
    content: userMessageAt(
      "draft a reply to Priya at Northwind about the vendor contract renewal",
      TIMEZONE,
      MORNING[0],
    ),
  },
  {
    role: "assistant",
    content:
      "Here is a draft:\n\nHi Priya, thanks for the renewal terms. We are happy to continue for another year, and we would like to confirm the support hours before we sign. Best, Yash",
  },
  {
    role: "user",
    content: userMessageAt(
      "make it warmer, and mention the onboarding help last quarter",
      TIMEZONE,
      MORNING[1],
      MORNING[0],
    ),
  },
  {
    role: "assistant",
    content:
      "Updated:\n\nHi Priya, thank you for the renewal terms, and for the onboarding help last quarter — it made a real difference for the team. We are glad to continue for another year. Could you confirm the support hours before we sign? Warm regards, Yash",
  },
  {
    role: "user",
    content: userMessageAt(
      "good. hold it for now, i want to check the numbers with finance",
      TIMEZONE,
      MORNING[2],
      MORNING[1],
    ),
  },
  { role: "assistant", content: "Sure. The draft is ready when you are." },
];

const QUESTION_KINDS = ["left", "next"] as const;

type Question = (typeof QUESTION_KINDS)[number];

const QUESTIONS = {
  left: "what is left on my calendar today?",
  next: "how long until my next meeting?",
} as const satisfies Record<Question, string>;

// The prompt differs by read path, and `system.current_time` is a direct call in both.
const READ_PATHS: ChatReadPath[] = ["direct", "code_run"];

interface Case {
  question: Question;
  asked: AskedAt;
  readPath: ChatReadPath;
}

interface TaskOutput {
  calledTools: string[];
  text: string;
}

const PAST_WORDS = /already|earlier|done|passed|over|finished|ended|completed|behind you/i;

/** Every event ahead is named; a line that names a past event also says that it is past. */
function scoreLeft(text: string, asked: AskedAt): string | null {
  const missing = asked.ahead.filter((name) => !name.test(text));

  if (missing.length > 0) return `missing ${missing.map(String).join(", ")}`;
  const lines = text.split(/\n|(?<=\.)\s+/);

  const pastShown = asked.past.filter((name) =>
    lines.some((line) => name.test(line) && !PAST_WORDS.test(line)),
  );

  return pastShown.length > 0 ? `lists past ${pastShown.map(String).join(", ")} as left` : null;
}

evalite<Case, TaskOutput, null>(
  "Agent answers from the time of the newest message (ADR-0130 decision 7)",
  {
    data: () =>
      READ_PATHS.flatMap((readPath) =>
        ASKED_AT.flatMap((asked) =>
          QUESTION_KINDS.map((question) => ({
            input: { question, asked, readPath },
            expected: null,
          })),
        ),
      ),
    task: async (input) => {
      serverEnv();

      if (currentTimeDescription === undefined)
        throw new Error(`${CURRENT_TIME_TOOL} is not registered`);

      const result = await generateText({
        model: route("standard").model(),
        instructions: buildChatSystemPrompt(
          "",
          CONNECTED_SUMMARY,
          selfIdentityGrounding(),
          input.readPath,
        ),
        messages: [
          ...HISTORY,
          {
            role: "user",
            content: userMessageAt(QUESTIONS[input.question], TIMEZONE, input.asked.at, MORNING[2]),
          },
        ],
        timeout: { totalMs: EVAL_TIMEOUT_MS },
        stopWhen: isStepCount(6),
        tools: {
          [CURRENT_TIME_TOOL]: tool({
            description: currentTimeDescription,
            inputSchema: z.object({}),
            execute: async () => currentTimeSnapshot(TIMEZONE, input.asked.at),
          }),
          "mcp.list_tools": tool({
            description:
              "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.",
            inputSchema: mcpToolSearchInputSchema,
            execute: async () => ({
              status: "tools",
              tools: [CALENDAR_LIST_HIT],
              nextCursor: null,
            }),
          }),
          "mcp.call": tool({
            description:
              "Invoke a tool on a connected MCP server. Supply the `connectionId` and `remoteName` of the ref returned by mcp.list_tools, plus `arguments` matching the tool schema.",
            inputSchema: mcpCallModelInput,
            execute: async () => TODAY_EVENTS,
          }),
        },
      });

      return {
        calledTools: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
        text: result.text,
      };
    },
    scorers: [
      {
        name: "Answers from the right time",
        scorer: ({ input, output }) => {
          const fault =
            input.question === "left"
              ? scoreLeft(output.text, input.asked)
              : input.asked.untilNext.test(output.text)
                ? null
                : `no ${String(input.asked.untilNext)}`;

          const calls = output.calledTools.join(", ") || "none";

          return {
            score: fault === null ? 1 : 0,
            metadata: `${input.asked.label} ${input.readPath}; calls=${calls}${fault === null ? "" : `; ${fault}; replied: ${output.text.slice(0, 240)}`}`,
          };
        },
      },
    ],
  },
);
