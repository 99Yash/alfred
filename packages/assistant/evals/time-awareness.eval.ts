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
import { firstUserMessage } from "./lib/grounding";

// ADR-0130 decision 7: chat shows the time only in time notes, so the latest note can be hours
// old. The model must call `system.current_time` when the answer depends on the current time.
// If it does not, the fix is the tool description, not a time line on each message.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant exec evalite run time-awareness`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

// The thread's only time note: 09:10 IST on Wed 10 June 2026. Each later message came less than
// 30 minutes after the one before, so none has a note.
const FIRST_NOTE_AT = new Date("2026-06-10T03:40:00Z");

// The real instant of the last message: 17:50 IST, the same day.
const LIVE_NOW = new Date("2026-06-10T12:20:00Z");

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

/** A working day with the user: one note at the start, then short gaps that add up to hours. */
const HISTORY: ModelMessage[] = [
  {
    role: "user",
    content: firstUserMessage(
      "draft a reply to Priya at Northwind about the vendor contract renewal",
      TIMEZONE,
      FIRST_NOTE_AT,
    ),
  },
  {
    role: "assistant",
    content:
      "Here is a draft:\n\nHi Priya, thanks for the renewal terms. We are happy to continue for another year, and we would like to confirm the support hours before we sign. Best, Yash",
  },
  { role: "user", content: "make it warmer, and mention the onboarding help last quarter" },
  {
    role: "assistant",
    content:
      "Updated:\n\nHi Priya, thank you for the renewal terms, and for the onboarding help last quarter — it made a real difference for the team. We are glad to continue for another year. Could you confirm the support hours before we sign? Warm regards, Yash",
  },
  { role: "user", content: "good. hold it for now, i want to check the numbers with finance" },
  { role: "assistant", content: "Sure. The draft is ready when you are." },
];

const QUESTIONS = [
  // Business hours at the other end: the answer depends on the current time.
  "ok finance is fine with it. is it too late to mail them today?",
  // "Left" means after now.
  "what is left on my calendar?",
];

// The prompt differs by read path, and `system.current_time` is a direct call in both.
const READ_PATHS: ChatReadPath[] = ["direct", "code_run"];

interface Case {
  question: string;
  readPath: ChatReadPath;
}

interface TaskOutput {
  calledTools: string[];
  text: string;
}

evalite<Case, TaskOutput, null>("Agent asks for the time (ADR-0130 decision 7)", {
  data: () =>
    READ_PATHS.flatMap((readPath) =>
      QUESTIONS.map((question) => ({ input: { question, readPath }, expected: null })),
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
      messages: [...HISTORY, { role: "user", content: input.question }],
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      stopWhen: isStepCount(6),
      tools: {
        [CURRENT_TIME_TOOL]: tool({
          description: currentTimeDescription,
          inputSchema: z.object({}),
          execute: async () => currentTimeSnapshot(TIMEZONE, LIVE_NOW),
        }),
        "mcp.list_tools": tool({
          description:
            "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.",
          inputSchema: mcpToolSearchInputSchema,
          execute: async () => ({ status: "tools", tools: [CALENDAR_LIST_HIT], nextCursor: null }),
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
      name: "Asks for the time",
      scorer: ({ output }) => {
        const asked = output.calledTools.includes(CURRENT_TIME_TOOL);

        return {
          score: asked ? 1 : 0,
          metadata: asked
            ? `calls=${output.calledTools.join(", ")}`
            : `no ${CURRENT_TIME_TOOL}; calls=${output.calledTools.join(", ") || "none"}; replied: ${output.text.slice(0, 200)}`,
        };
      },
    },
  ],
});
