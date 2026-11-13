import path from "node:path";
import { route } from "@alfred/ai";
import {
  getStringPath,
  isRecord,
  mcpCallInput,
  mcpToolSearchInputSchema,
  parseIanaTimezone,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatRuntimeTimeGrounding } from "@alfred/assistant/execution/grounding";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { toolCallArgs } from "./lib/grounding";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// ADR-0055: asked about "october 2026", chat once replied "which year?" because it had no "now".
// The calendar is a Google Workspace MCP built-in (ADR-0126). The catalog lookup answers, and
// `mcp.call` has no `execute`, so the run stops at the remote call and we check its arguments.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" so expected windows are stable: noon IST on Wed 10 June 2026.
const NOW = new Date("2026-06-10T06:30:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const MCP_LIST_TOOLS_TOOL = "mcp.list_tools";

const MCP_CALL_TOOL = "mcp.call";

const CALENDAR_CONNECTION = {
  id: "mcp_conn_google_calendar",
  instanceKey: "calendar",
  label: "Google Calendar",
};

const CALENDAR_CATALOG_REVISION = "rev_google_calendar_eval";

const CALENDAR_LIST_REMOTE = "list_events";

const CALENDAR_LIST_HIT = {
  ref: {
    kind: "mcp",
    connectionId: CALENDAR_CONNECTION.id,
    remoteName: CALENDAR_LIST_REMOTE,
    catalogRevision: CALENDAR_CATALOG_REVISION,
  },
  namespace: CALENDAR_CONNECTION.instanceKey,
  connection: CALENDAR_CONNECTION,
  description: "List the events on the user's calendar in a time range.",
};

// A connected summary for a Google user (ADR-0053). The prompt must embed it.
const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.send_draft — the user's email",
  `- ${JSON.stringify(CALENDAR_CONNECTION.label)} MCP server (connectionId ${CALENDAR_CONNECTION.id}) — 9 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
].join("\n");

interface TargetWindow {
  /** Inclusive. */
  fromISO: string;
  /** Exclusive. */
  toISO: string;
}

interface Case {
  input: string;
  /** null accepts any sensible call. */
  target: TargetWindow | null;
}

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
  system: string;
}

const CASES: Case[] = [
  {
    // The prod bug.
    input: "how many meetings do i have in october 2026",
    target: { fromISO: "2026-10-01", toISO: "2026-11-01" },
  },
  {
    // The year comes from "now": December 2026.
    input: "do i have anything in december",
    target: { fromISO: "2026-12-01", toISO: "2027-01-01" },
  },
  {
    input: "what's on my calendar next week",
    target: null,
  },
  {
    // Must call the tool, not ask which Thursday.
    input: "am i free thursday afternoon",
    target: null,
  },
];

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);

  return Number.isNaN(d.getTime()) ? null : d;
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** The `arguments` of an `mcp.call` to the calendar list tool, else `null`. */
function calendarListArguments(input: unknown): Record<string, unknown> | null {
  if (
    getStringPath(input, "connectionId") !== CALENDAR_CONNECTION.id ||
    getStringPath(input, "remoteName") !== CALENDAR_LIST_REMOTE
  ) {
    return null;
  }

  const args = isRecord(input) ? input.arguments : undefined;

  return isRecord(args) ? args : null;
}

/**
 * True when the call's time range overlaps the target window [from, to). The remote schema
 * names its bounds, so the range is the earliest and the latest date value in the arguments.
 */
function windowOverlaps(args: Record<string, unknown>, target: TargetWindow): boolean {
  // Only ISO dates count: `new Date("10")` also parses.
  const dates = Object.values(args)
    .filter((value) => typeof value === "string" && ISO_DATE_PREFIX.test(value))
    .map(parseDate)
    .filter((d): d is Date => d !== null)
    .toSorted((a, b) => a.getTime() - b.getTime());

  const start = dates[0];
  const end = dates.at(-1);

  // A specific month needs explicit bounds on both sides.
  if (dates.length < 2 || !start || !end) return false;
  const from = new Date(`${target.fromISO}T00:00:00Z`);
  const to = new Date(`${target.toISO}T00:00:00Z`);

  return start < to && end > from;
}

evalite<string, TaskOutput, TargetWindow | null>("Agent date grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.target })),
  task: async (input) => {
    serverEnv();
    // Like prod: the system prompt has no date. "Now" comes from the runtime line (#410).
    const system = buildChatSystemPrompt("", CONNECTED_SUMMARY, selfIdentityGrounding());

    const result = await generateText({
      model: route("standard").model(),
      instructions: system,
      messages: [
        { role: "assistant", content: formatRuntimeTimeGrounding(TIMEZONE, NOW) },
        { role: "user", content: input },
      ],
      temperature: 0,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      // The catalog lookup, then the remote call.
      stopWhen: isStepCount(3),
      tools: {
        [MCP_LIST_TOOLS_TOOL]: tool({
          description:
            "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.",
          inputSchema: mcpToolSearchInputSchema,
          execute: async () => ({ status: "tools", tools: [CALENDAR_LIST_HIT], nextCursor: null }),
        }),
        [MCP_CALL_TOOL]: tool({
          description:
            "Invoke a tool on a connected MCP server. Supply the `connectionId`, remote `remoteName`, and `catalogRevision` from the exact ref returned by mcp.list_tools, plus `arguments` matching the tool schema.",
          inputSchema: mcpCallInput,
        }),
      },
    });

    const calls = result.steps.flatMap((step) => step.toolCalls);
    const call = calls.find((c) => calendarListArguments(c.input) !== null);

    return {
      toolName: call ? CALENDAR_LIST_REMOTE : (calls.at(-1)?.toolName ?? null),
      args: call ? calendarListArguments(call.input) : toolCallArgs(calls.at(-1)?.input),
      text: result.text,
      system,
    };
  },
  scorers: [
    {
      name: "Calls calendar tool",
      scorer: ({ output }) => ({
        score: output.toolName === CALENDAR_LIST_REMOTE ? 1 : 0,
        metadata:
          output.toolName === CALENDAR_LIST_REMOTE
            ? `args=${JSON.stringify(output.args)}`
            : `no calendar call; replied: ${output.text.slice(0, 200)}`,
      }),
    },
    {
      // Auto-passes for relative-window cases.
      name: "Targets the right window",
      scorer: ({ output, expected }) => {
        if (!expected) return { score: 1, metadata: "n/a (relative window)" };

        if (output.toolName !== CALENDAR_LIST_REMOTE) {
          return { score: 0, metadata: "no calendar call to evaluate" };
        }

        const ok = output.args ? windowOverlaps(output.args, expected) : false;

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `covers ${expected.fromISO}..${expected.toISO}`
            : `does not cover ${expected.fromISO}..${expected.toISO}: ${JSON.stringify(output.args)}`,
        };
      },
    },
    {
      // ADR-0053: the connected summary must reach the system prompt.
      name: "Grounds connected integrations",
      scorer: ({ output }) => {
        const ok =
          output.system.includes("integration.action") &&
          output.system.includes(CALENDAR_CONNECTION.id);

        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? "system prompt carries the connected summary"
            : "connected summary missing from system prompt",
        };
      },
    },
  ],
});
