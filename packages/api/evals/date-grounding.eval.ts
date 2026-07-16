import path from "node:path";
import { getChatModel } from "@alfred/ai";
import { calendarListEventsInput } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatRuntimeTimeGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// ADR-0055: behavioral eval for agent date grounding. Guards the regression
// where the chat agent, given "how many meetings do i have in october 2026",
// replied "which year?" instead of calling the calendar tool — because the
// system prompt never told it what "now" is. We run the REAL grounded chat
// prompt against the standard chat model with the calendar tool exposed (no
// `execute`, so the model stops at the tool call) and assert deterministically
// on the call it makes. Deterministic scorers, no LLM judge — the tool call
// either targets the right window or it doesn't.
//
// Run locally with ANTHROPIC_API_KEY in env: `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" so expected windows are stable: noon IST on Wed 10 June 2026.
const NOW = new Date("2026-06-10T06:30:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const CALENDAR_TOOL = "calendar.list_events";

// A representative connected summary, in the exact shape `buildConnectedSummary`
// emits for a Google + GitHub user (ADR-0053). We assert the prompt builder
// actually embeds it — a regression guard against the connected-summary param
// being dropped from the system prompt the way the date once was.
const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message, gmail.send_draft — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- github.search, github.get_pull_request, github.get_issue — the user's GitHub issues and pull requests",
].join("\n");

interface TargetWindow {
  /** Inclusive lower bound (ISO date) the call's window must reach into. */
  fromISO: string;
  /** Exclusive upper bound (ISO date) the call's window must reach into. */
  toISO: string;
}

interface Case {
  input: string;
  /** Specific month the call must cover, or null for "any sensible call". */
  target: TargetWindow | null;
}

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
  /** The resolved system prompt sent to the model — asserted for grounding content. */
  system: string;
}

const CASES: Case[] = [
  {
    // The actual prod bug: explicit future month, year stated outright.
    input: "how many meetings do i have in october 2026",
    target: { fromISO: "2026-10-01", toISO: "2026-11-01" },
  },
  {
    // Partial date — year must be inferred from "today" (June 2026 → Dec 2026).
    input: "do i have anything in december",
    target: { fromISO: "2026-12-01", toISO: "2027-01-01" },
  },
  {
    // Relative window the tool's enum covers — just must reach for the tool.
    input: "what's on my calendar next week",
    target: null,
  },
  {
    // Relative day — must call the tool, not ask which Thursday.
    input: "am i free thursday afternoon",
    target: null,
  },
];

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when [start, end) overlaps the target window [from, to). */
function windowOverlaps(args: Record<string, unknown>, target: TargetWindow): boolean {
  const start = parseDate(args.timeMin);
  const end = parseDate(args.timeMax);
  // A specific month is outside the today/tomorrow/next_7_days enums, so the
  // only correct call uses explicit RFC3339 bounds. A relative `window` here is
  // a miss by construction.
  if (!start || !end) return false;
  const from = new Date(`${target.fromISO}T00:00:00Z`);
  const to = new Date(`${target.toISO}T00:00:00Z`);
  return start < to && end > from;
}

evalite<string, TaskOutput, TargetWindow | null>("Agent date grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.target })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    // Mirror an artifact-free first prod call: chat's system prompt states no
    // date, and "now" rides the ephemeral runtime line as an assistant turn just
    // before the user's message (withEphemeralReference). Grounding the eval the
    // same way keeps it a faithful guard for the single-source path (#410).
    const system = buildChatSystemPrompt("", CONNECTED_SUMMARY);
    const result = await generateText({
      model: getChatModel("standard"),
      system,
      messages: [
        { role: "assistant", content: formatRuntimeTimeGrounding(TIMEZONE, NOW) },
        { role: "user", content: input },
      ],
      temperature: 0,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      tools: {
        // Mirror the prod registration: calendar already active, read-only list
        // tool with the real contract schema, no `execute` so the model stops
        // at the call and we can inspect its args.
        [CALENDAR_TOOL]: tool({
          description:
            "List Google Calendar events. Prefer the relative window fields for today/tomorrow/next-week questions; use explicit RFC3339 bounds only when the user gave exact dates or times.",
          inputSchema: calendarListEventsInput,
        }),
      },
    });
    const call = result.toolCalls.find((c) => c.toolName === CALENDAR_TOOL) ?? result.toolCalls[0];
    return {
      toolName: call?.toolName ?? null,
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
      system,
    };
  },
  scorers: [
    {
      // The core regression: reach for the calendar tool instead of bouncing
      // the question back to the user.
      name: "Calls calendar tool",
      scorer: ({ output }) => ({
        score: output.toolName === CALENDAR_TOOL ? 1 : 0,
        metadata:
          output.toolName === CALENDAR_TOOL
            ? `args=${JSON.stringify(output.args)}`
            : `no calendar call; replied: ${output.text.slice(0, 200)}`,
      }),
    },
    {
      // For a specific month, the call must use explicit bounds that actually
      // cover that month. N/A (auto-pass) for relative-window cases.
      name: "Targets the right window",
      scorer: ({ output, expected }) => {
        if (!expected) return { score: 1, metadata: "n/a (relative window)" };
        if (output.toolName !== CALENDAR_TOOL) {
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
      // ADR-0053 / GROUND-001: the connected summary must reach the model in
      // the same grounded system prompt as the date. Deterministic — the
      // built prompt either embeds the exact-slug calendar line or it doesn't.
      name: "Grounds connected integrations",
      scorer: ({ output }) => {
        const ok =
          output.system.includes("integration.action") &&
          output.system.includes("calendar.list_events");
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
