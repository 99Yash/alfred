import path from "node:path";
import { route } from "@alfred/ai";
import {
  getStringPath,
  mcpCallInput,
  mcpToolSearchInputSchema,
  parseIanaTimezone,
  rememberInput,
  resolveTodoInput,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "@alfred/assistant/execution/grounding";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import { toolCallArgs, type GroundingTaskOutput } from "./lib/grounding";
import { selfIdentityGrounding } from "@alfred/assistant/settings";

// #312: when the user describes a sender ("the recruiter") and asks to mute it, the boss must
// find the address with a Gmail search, not ask the user for it. A literal model once asked.
// Gmail is a Google Workspace MCP built-in (ADR-0126), so the search is an `mcp.call` to the Gmail
// server's `search_threads`. In the first suite only the catalog lookup answers, so the run stops
// at the first real call and we check it.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-27T04:44:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const MCP_LIST_TOOLS_TOOL = "mcp.list_tools";

const MCP_CALL_TOOL = "mcp.call";

const GMAIL_CONNECTION = { id: "mcp_conn_gmail", instanceKey: "gmail", label: "Gmail" };

const GMAIL_CATALOG_REVISION = "rev_gmail_eval";

const GMAIL_SEARCH_REMOTE = "search_threads";

/** The label a Gmail search call gets in the tool path. */
const SEARCH_STEP = `${GMAIL_CONNECTION.label}.${GMAIL_SEARCH_REMOTE}`;

const GMAIL_SEARCH_HIT = {
  ref: {
    kind: "mcp",
    connectionId: GMAIL_CONNECTION.id,
    remoteName: GMAIL_SEARCH_REMOTE,
    catalogRevision: GMAIL_CATALOG_REVISION,
  },
  namespace: GMAIL_CONNECTION.instanceKey,
  connection: GMAIL_CONNECTION,
  description:
    "Search the user's Gmail threads with Gmail search operators. Each hit has the thread id, sender, subject, snippet, and date.",
};

const MCP_LIST_TOOLS_DESCRIPTION =
  "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.";

const MCP_CALL_DESCRIPTION =
  "Invoke a tool on a connected MCP server. Supply the `connectionId`, remote `remoteName`, and `catalogRevision` from the exact ref returned by mcp.list_tools, plus `arguments` matching the tool schema.";

function isGmailSearchCall(toolName: string, input: unknown): boolean {
  return (
    toolName === MCP_CALL_TOOL &&
    getStringPath(input, "connectionId") === GMAIL_CONNECTION.id &&
    getStringPath(input, "remoteName") === GMAIL_SEARCH_REMOTE
  );
}

/** A catalog lookup only finds the search tool, so the tool path leaves it out. */
function stepName(call: { toolName: string; input: unknown }): string | null {
  if (call.toolName === MCP_LIST_TOOLS_TOOL) return null;

  return isGmailSearchCall(call.toolName, call.input) ? SEARCH_STEP : call.toolName;
}

const REMEMBER_TOOL = "system.remember";

const RESOLVE_TODO_TOOL = "system.resolve_todo";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  `- ${JSON.stringify(GMAIL_CONNECTION.label)} MCP server (connectionId ${GMAIL_CONNECTION.id}) — 10 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
  "- system.remember — store a standing instruction the user confirms on a card",
  "- system.resolve_todo — dismiss live todos by resolved Gmail sender",
].join("\n");

const SYSTEM = buildChatSystemPrompt(
  formatDateGrounding(TIMEZONE, NOW),
  CONNECTED_SUMMARY,
  selfIdentityGrounding(),
);

interface Case {
  input: string;
}

interface RememberCall {
  senderEmail: string | null;
  senderLabel: string | null;
}

interface ResolutionTaskOutput {
  toolNames: string[];
  remembered: RememberCall[];
  resolvedTodos: RememberCall[];
  text: string;
}

/** The Gmail MCP search answer the eval returns. Only the sender metadata matters here. */
interface GmailThreadHits {
  threads: Array<{ id: string; from: string; subject: string; snippet: string; date: string }>;
}

interface ResolutionInput {
  prompt: string;
  searchResult: GmailThreadHits;
}

interface ResolutionCase {
  input: string;
  searchResult: GmailThreadHits;
  expectedRememberEmail: string | null;
}

// Each case describes the sender and never gives an address.
const CASES: Case[] = [
  { input: "the acme onboarding emails are noise, stop surfacing them as todos or in briefings" },
  { input: "stop showing me todos from the recruiter emails, they're not useful" },
  { input: "i don't care about that linkedin job-alert newsletter anymore, quit surfacing it" },
];

function runFirstCall(input: string) {
  const modelRoute = route("standard");

  return generateText({
    model: modelRoute.model(),
    instructions: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    // The catalog lookup, then the first real call.
    stopWhen: isStepCount(3),
    tools: {
      [MCP_LIST_TOOLS_TOOL]: tool({
        description: MCP_LIST_TOOLS_DESCRIPTION,
        inputSchema: mcpToolSearchInputSchema,
        execute: async () => ({ status: "tools", tools: [GMAIL_SEARCH_HIT], nextCursor: null }),
      }),
      [MCP_CALL_TOOL]: tool({
        description: MCP_CALL_DESCRIPTION,
        inputSchema: mcpCallInput,
      }),
      [REMEMBER_TOOL]: tool({
        description:
          "Persist a resolved sender-level suppression standing instruction. Only persists when the " +
          "sender email is resolved; otherwise returns a clarification request. When the user names " +
          "several senders, pass them all in `senders` in ONE call; each gets its own instruction and " +
          "its own result. Never call this once per sender.",
        inputSchema: rememberInput,
      }),
      [RESOLVE_TODO_TOOL]: tool({
        description:
          "Dismiss live todos by resolved Gmail sender or Gmail thread source. Use after storing a " +
          "sender suppression so current matching todos disappear instead of lingering.",
        inputSchema: resolveTodoInput,
      }),
    },
  });
}

const CLEAR_SHAPESHIFTER_HIT: GmailThreadHits = {
  threads: [
    {
      id: "thr_clear_shape",
      from: "ShapeShifter <no-reply@shapeshifter.so>",
      subject: 'Acme onboarding milestone "Professional Networking" due tomorrow',
      snippet: "Your Acme onboarding milestone is due tomorrow. Complete it in ShapeShifter.",
      date: "2026-06-27T03:15:00.000Z",
    },
  ],
};

const AMBIGUOUS_ONBOARDING_HITS: GmailThreadHits = {
  threads: [
    {
      id: "thr_resend",
      from: "Acme <onboarding@resend.dev>",
      subject: "Welcome to Acme onboarding",
      snippet: "Set up your Acme workspace and finish the onboarding checklist.",
      date: "2026-06-26T09:00:00.000Z",
    },
    {
      id: "thr_shape",
      from: "ShapeShifter <no-reply@shapeshifter.so>",
      subject: 'Acme onboarding milestone "Professional Networking" due tomorrow',
      snippet: "Your Acme onboarding milestone is due tomorrow. Complete it in ShapeShifter.",
      date: "2026-06-27T03:15:00.000Z",
    },
  ],
};

const WEAK_ONBOARDING_HIT: GmailThreadHits = {
  threads: [
    {
      id: "thr_weak",
      from: "LinkedIn Job Alerts <jobs-noreply@linkedin.com>",
      subject: "New jobs for product engineers",
      snippet: "Here are jobs matching your profile. Apply before the end of the week.",
      date: "2026-06-27T02:00:00.000Z",
    },
  ],
};

const RESOLUTION_CASES: ResolutionCase[] = [
  {
    input: "the acme onboarding emails are noise, stop surfacing them as todos or in briefings",
    searchResult: CLEAR_SHAPESHIFTER_HIT,
    expectedRememberEmail: "no-reply@shapeshifter.so",
  },
  {
    input: "the acme onboarding emails are noise, stop surfacing them as todos or in briefings",
    searchResult: AMBIGUOUS_ONBOARDING_HITS,
    expectedRememberEmail: null,
  },
  {
    input: "the acme onboarding emails are noise, stop surfacing them as todos or in briefings",
    searchResult: WEAK_ONBOARDING_HIT,
    expectedRememberEmail: null,
  },
];

async function runResolutionScenario(
  input: string,
  searchResult: GmailThreadHits,
): Promise<ResolutionTaskOutput> {
  const remembered: RememberCall[] = [];
  const resolvedTodos: RememberCall[] = [];
  const modelRoute = route("standard");

  const result = await generateText({
    model: modelRoute.model(),
    instructions: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    stopWhen: isStepCount(4),
    tools: {
      [MCP_LIST_TOOLS_TOOL]: tool({
        description: MCP_LIST_TOOLS_DESCRIPTION,
        inputSchema: mcpToolSearchInputSchema,
        execute: async () => ({ status: "tools", tools: [GMAIL_SEARCH_HIT], nextCursor: null }),
      }),
      [MCP_CALL_TOOL]: tool({
        description: MCP_CALL_DESCRIPTION,
        inputSchema: mcpCallInput,
        execute: async ({ remoteName }) =>
          remoteName === GMAIL_SEARCH_REMOTE
            ? searchResult
            : { error: `Unknown tool ${remoteName} in catalog ${GMAIL_CATALOG_REVISION}.` },
      }),
      [REMEMBER_TOOL]: tool({
        description:
          "Store a standing instruction. Put a sender in `targets` only when the Gmail search " +
          "result clearly identifies the one sender the user described; ask the user instead on " +
          "ambiguous hits.",
        inputSchema: rememberInput,
        execute: async (input) => {
          const senderEmail = input.targets?.find((target) => target.includes("@")) ?? null;

          remembered.push({ senderEmail, senderLabel: null });

          return {
            ok: true,
            status: "remembered",
            factId: "fact_eval_sender",
            instruction: { targets: input.targets ?? [], effects: input.effects },
            related: [],
            resolvedTodos: [{ ok: true, status: "not_found", dismissedCount: 0 }],
          };
        },
      }),
      [RESOLVE_TODO_TOOL]: tool({
        description:
          "Dismiss live todos by resolved Gmail sender or Gmail thread source. Use after storing a " +
          "sender suppression so current matching todos disappear instead of lingering.",
        inputSchema: resolveTodoInput,
        execute: async (input) => {
          resolvedTodos.push({
            senderEmail: typeof input.senderEmail === "string" ? input.senderEmail : null,
            senderLabel: null,
          });

          return {
            ok: true,
            status: "not_found",
            dismissedCount: 0,
            todoIds: [],
            matchedThreadIds: [],
          };
        },
      }),
    },
  });

  return {
    toolNames: result.steps.flatMap((step) =>
      step.toolCalls.flatMap((call) => {
        const name = stepName(call);

        return name === null ? [] : [name];
      }),
    ),
    remembered,
    resolvedTodos,
    text: result.text,
  };
}

evalite<string, GroundingTaskOutput, null>(
  "Agent sender-suppression grounding — search before ask",
  {
    data: () => CASES.map((c) => ({ input: c.input, expected: null })),
    task: async (input) => {
      serverEnv();

      // Never throw: evalite's reporter hangs the job on an error. Score 0 instead.
      try {
        const result = await runFirstCall(input);

        const call = result.steps
          .flatMap((step) => step.toolCalls)
          .find((c) => stepName(c) !== null);

        return {
          toolName: call ? stepName(call) : null,
          args: toolCallArgs(call?.input),
          text: result.text,
        };
      } catch (err) {
        return {
          toolName: null,
          args: null,
          text: `ERROR: ${toMessage(err)}`,
        };
      }
    },
    scorers: [
      {
        // Not a text reply asking for the address, and not a blind system.remember.
        name: "First move is a Gmail search (resolves the sender itself)",
        scorer: ({ output }) => ({
          score: output.toolName === SEARCH_STEP ? 1 : 0,
          metadata:
            output.toolName === SEARCH_STEP
              ? `searched: ${JSON.stringify(output.args)}`
              : output.toolName === null
                ? `NO tool call — asked instead of searching: ${output.text.slice(0, 200)}`
                : `reached for ${output.toolName} before searching: ${JSON.stringify(output.args)}`,
        }),
      },
      {
        // A blunter signal: did it act at all?
        name: "Did not punt — made a tool call instead of asking",
        scorer: ({ output }) => ({
          score: output.toolName !== null ? 1 : 0,
          metadata:
            output.toolName !== null
              ? `acted via ${output.toolName}`
              : `punted with a question: ${output.text.slice(0, 200)}`,
        }),
      },
    ],
  },
);

evalite<ResolutionInput, ResolutionTaskOutput, string | null>(
  "Agent sender-suppression grounding — persists only clear sender matches",
  {
    data: () =>
      RESOLUTION_CASES.map((c) => ({
        input: { prompt: c.input, searchResult: c.searchResult },
        expected: c.expectedRememberEmail,
      })),
    task: async (input) => {
      serverEnv();

      try {
        return await runResolutionScenario(input.prompt, input.searchResult);
      } catch (err) {
        return {
          toolNames: [],
          remembered: [],
          resolvedTodos: [],
          text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    scorers: [
      {
        name: "Searches Gmail before deciding",
        scorer: ({ output }) => ({
          score: output.toolNames[0] === SEARCH_STEP ? 1 : 0,
          metadata:
            output.toolNames[0] === SEARCH_STEP
              ? `tool path: ${output.toolNames.join(" -> ")}`
              : `did not start with search: ${output.toolNames.join(" -> ")} ${output.text.slice(0, 200)}`,
        }),
      },
      {
        name: "Remembers exactly one clear sender and no ambiguous sender",
        scorer: ({ output, expected }) => {
          if (expected === null) {
            const ok = output.remembered.length === 0 && output.resolvedTodos.length === 0;

            return {
              score: ok ? 1 : 0,
              metadata: ok
                ? "no sender persisted or resolved from ambiguous/weak hits"
                : `acted on ambiguous/weak hits: remembered=${JSON.stringify(output.remembered)} resolved=${JSON.stringify(output.resolvedTodos)}`,
            };
          }

          const rememberedEmails = output.remembered.map((call) => call.senderEmail);
          const ok = rememberedEmails.length === 1 && rememberedEmails[0] === expected;

          return {
            score: ok ? 1 : 0,
            metadata: ok
              ? `remembered ${expected}`
              : `expected ${expected}; remembered=${JSON.stringify(output.remembered)}; text=${output.text.slice(0, 200)}`,
          };
        },
      },
    ],
  },
);
