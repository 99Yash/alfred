import path from "node:path";
import { route } from "@alfred/ai";
import { calendarListEventsInput, parseIanaTimezone } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatRuntimeTimeGrounding } from "@alfred/assistant/execution/grounding";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// ADR-0055: asked about "october 2026", chat once replied "which year?" because it had no "now".
// The tool has no `execute`, so the run stops at the call and we check its args.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" so expected windows are stable: noon IST on Wed 10 June 2026.
const NOW = new Date("2026-06-10T06:30:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const CALENDAR_TOOL = "calendar.list_events";

// A connected summary for a Google + GitHub user (ADR-0053). The prompt must embed it.
const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message, gmail.send_draft — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- github.search, github.get_pull_request, github.get_issue — the user's GitHub issues and pull requests",
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

/** True when [start, end) overlaps the target window [from, to). */
function windowOverlaps(args: Record<string, unknown>, target: TargetWindow): boolean {
  const start = parseDate(args.timeMin);
  const end = parseDate(args.timeMax);

  // No `window` value covers a specific month, so only explicit bounds can be right.
  if (!start || !end) return false;
  const from = new Date(`${target.fromISO}T00:00:00Z`);
  const to = new Date(`${target.toISO}T00:00:00Z`);

  return start < to && end > from;
}

evalite<string, TaskOutput, TargetWindow | null>("Agent date grounding", {
  data: () => CASES.map((c) => ({ input: c.input, expected: c.target })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    // Like prod: the system prompt has no date. "Now" comes from the runtime line (#410).
    const system = buildChatSystemPrompt("", CONNECTED_SUMMARY, selfIdentityGrounding());

    const result = await generateText({
      model: route("standard").model(),
      system,
      messages: [
        { role: "assistant", content: formatRuntimeTimeGrounding(TIMEZONE, NOW) },
        { role: "user", content: input },
      ],
      temperature: 0,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      tools: {
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
      // SAFETY: diagnostic view of the tool-call input; `??` covers absence.
      args: (call?.input as Record<string, unknown> | undefined) ?? null,
      text: result.text,
      system,
    };
  },
  scorers: [
    {
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
      // Auto-passes for relative-window cases.
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
      // ADR-0053: the connected summary must reach the system prompt.
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
