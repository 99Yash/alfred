import path from "node:path";
import { getChatModel, getChatProviderOptions } from "@alfred/ai";
import {
  gmailSearchInput,
  gmailSearchResultSchema,
  rememberInput,
  resolveTodoInput,
  type GmailSearchResult,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";
import type { GroundingTaskOutput } from "./lib/grounding";

// GROUND / #312: behavioral guard that when the user names a sender by
// DESCRIPTION ("the onboarding emails", "the recruiter") and asks to stop
// surfacing it, the boss resolves the concrete address itself with gmail.search
// FIRST, instead of asking the user for an address it could look up. This was a
// real regression surfaced while adjudicating a cheaper Auto-tier model (Haiku
// 4.5): the prompt said to act "after resolving a concrete sender email" but
// never said *resolving = search Gmail*, so a more literal model read it as
// "ask the user". The #312 prompt fix makes search-before-ask explicit; this
// eval pins it so a future model swap (or prompt edit) can't silently regress
// back to asking. We expose gmail.search / system.remember / system.resolve_todo
// with no `execute`, so the run halts on the first tool call and we assert on it.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-27T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const SEARCH_TOOL = "gmail.search";
const REMEMBER_TOOL = "system.remember";
const RESOLVE_TODO_TOOL = "system.resolve_todo";

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message — the user's email",
  "- system.remember — persist a sender-level suppression standing instruction",
  "- system.resolve_todo — dismiss live todos by resolved Gmail sender",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

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

interface ResolutionInput {
  prompt: string;
  searchResult: GmailSearchResult;
}

interface ResolutionCase {
  input: string;
  searchResult: GmailSearchResult;
  expectedRememberEmail: string | null;
}

// Each names the sender by DESCRIPTION, never an exact address — so the only
// way to act correctly is to search Gmail to resolve it. A model that asks for
// the address is the regression we're guarding against.
const CASES: Case[] = [
  { input: "the acme onboarding emails are noise, stop surfacing them as todos or in briefings" },
  { input: "stop showing me todos from the recruiter emails, they're not useful" },
  { input: "i don't care about that linkedin job-alert newsletter anymore, quit surfacing it" },
];

function runFirstCall(input: string) {
  return generateText({
    model: getChatModel("standard"),
    instructions: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: standardProviderOptions(),
    // Real tool surface, execute-less so the run halts on the first tool call
    // and we can inspect what the model reached for first.
    tools: {
      [SEARCH_TOOL]: tool({
        description:
          "Search Gmail messages using Gmail query operators. Each hit carries the headers needed to " +
          "identify it without a follow-up read: `from` (sender), `subject`, `snippet`, `authoredAt`, " +
          "plus `messageId`/`threadId` and a `documentId` when the message has been ingested. Use " +
          "`from`/`subject` to pick the right hit — don't infer a sender from the query.",
        inputSchema: gmailSearchInput,
      }),
      [REMEMBER_TOOL]: tool({
        description:
          "Persist a resolved sender-level suppression standing instruction. Only persists when the " +
          "sender email is resolved; otherwise returns a clarification request.",
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

const CLEAR_SHAPESHIFTER_HIT = gmailSearchResultSchema.parse({
  messages: [
    {
      messageId: "msg_clear_shape",
      threadId: "thr_clear_shape",
      documentId: "doc_clear_shape",
      from: "ShapeShifter <no-reply@shapeshifter.so>",
      subject: 'Acme onboarding milestone "Professional Networking" due tomorrow',
      snippet: "Your Acme onboarding milestone is due tomorrow. Complete it in ShapeShifter.",
      authoredAt: "2026-06-27T03:15:00.000Z",
      url: "https://mail.google.com/mail/u/0/#all/thr_clear_shape",
    },
  ],
  nextPageToken: null,
});

const AMBIGUOUS_ONBOARDING_HITS = gmailSearchResultSchema.parse({
  messages: [
    {
      messageId: "msg_resend",
      threadId: "thr_resend",
      documentId: "doc_resend",
      from: "Acme <onboarding@resend.dev>",
      subject: "Welcome to Acme onboarding",
      snippet: "Set up your Acme workspace and finish the onboarding checklist.",
      authoredAt: "2026-06-26T09:00:00.000Z",
      url: "https://mail.google.com/mail/u/0/#all/thr_resend",
    },
    {
      messageId: "msg_shape",
      threadId: "thr_shape",
      documentId: "doc_shape",
      from: "ShapeShifter <no-reply@shapeshifter.so>",
      subject: 'Acme onboarding milestone "Professional Networking" due tomorrow',
      snippet: "Your Acme onboarding milestone is due tomorrow. Complete it in ShapeShifter.",
      authoredAt: "2026-06-27T03:15:00.000Z",
      url: "https://mail.google.com/mail/u/0/#all/thr_shape",
    },
  ],
  nextPageToken: null,
});

const WEAK_ONBOARDING_HIT = gmailSearchResultSchema.parse({
  messages: [
    {
      messageId: "msg_weak",
      threadId: "thr_weak",
      documentId: "doc_weak",
      from: "LinkedIn Job Alerts <jobs-noreply@linkedin.com>",
      subject: "New jobs for product engineers",
      snippet: "Here are jobs matching your profile. Apply before the end of the week.",
      authoredAt: "2026-06-27T02:00:00.000Z",
      url: "https://mail.google.com/mail/u/0/#all/thr_weak",
    },
  ],
  nextPageToken: null,
});

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

function standardProviderOptions(): Record<string, never> {
  // SAFETY: This mirrors `AlfredAgent`, which casts the project-level
  // provider-options helper at the AI SDK boundary. The helper is intentionally
  // looser so callers don't import provider-internal SDK types.
  return getChatProviderOptions("standard") as unknown as Record<string, never>;
}

async function runResolutionScenario(
  input: string,
  searchResult: GmailSearchResult,
): Promise<ResolutionTaskOutput> {
  const remembered: RememberCall[] = [];
  const resolvedTodos: RememberCall[] = [];
  const result = await generateText({
    model: getChatModel("standard"),
    instructions: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: standardProviderOptions(),
    stopWhen: isStepCount(4),
    tools: {
      [SEARCH_TOOL]: tool({
        description:
          "Search Gmail messages using Gmail query operators. Each hit carries `from`, `subject`, " +
          "`snippet`, `authoredAt`, `messageId`, `threadId`, and `documentId`. Use the hit metadata " +
          "to determine whether one sender clearly matches the user's description; ask if hits are mixed.",
        inputSchema: gmailSearchInput,
        execute: async () => searchResult,
      }),
      [REMEMBER_TOOL]: tool({
        description:
          "Persist a resolved sender-level suppression standing instruction. Only call this when " +
          "the Gmail search result clearly identifies one sender; ask the user instead on ambiguous hits.",
        inputSchema: rememberInput,
        execute: async (input) => {
          remembered.push({
            senderEmail: typeof input.senderEmail === "string" ? input.senderEmail : null,
            senderLabel: typeof input.senderLabel === "string" ? input.senderLabel : null,
          });
          return {
            ok: true,
            status: "remembered",
            factId: "fact_eval_sender",
            instruction: {
              target: { email: input.senderEmail ?? null, label: input.senderLabel ?? null },
            },
            resolvedTodos: { ok: true, status: "not_found", dismissedCount: 0 },
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
    toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
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
      void serverEnv().ANTHROPIC_API_KEY;
      // Per the eval-lane lesson (project_triage_eval_provider_coupling): an eval
      // must never throw, or evalite's reporter hangs the whole job on a transient
      // provider blip. Degrade to an empty result so the scorers just score 0.
      try {
        const result = await runFirstCall(input);
        const call = result.toolCalls[0];
        return {
          toolName: call?.toolName ?? null,
          args: (call?.input as Record<string, unknown> | undefined) ?? null,
          text: result.text,
        };
      } catch (err) {
        return { toolName: null, args: null, text: `ERROR: ${(err as Error).message}` };
      }
    },
    scorers: [
      {
        // The core regression: the FIRST move must be gmail.search to resolve the
        // sender — not a text reply asking for the address, and not a blind
        // system.remember without an address it could have looked up.
        name: "First move is gmail.search (resolves the sender itself)",
        scorer: ({ output }) => ({
          score: output.toolName === SEARCH_TOOL ? 1 : 0,
          metadata:
            output.toolName === SEARCH_TOOL
              ? `searched: ${JSON.stringify(output.args)}`
              : output.toolName === null
                ? `NO tool call — asked instead of searching: ${output.text.slice(0, 200)}`
                : `reached for ${output.toolName} before searching: ${JSON.stringify(output.args)}`,
        }),
      },
      {
        // Separate, blunter signal: did it act at all, or punt back to the user?
        // Catches the exact Haiku failure mode ("what's the sender's address?").
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
      void serverEnv().ANTHROPIC_API_KEY;
      const searchResult = gmailSearchResultSchema.parse(input.searchResult);
      try {
        return await runResolutionScenario(input.prompt, searchResult);
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
          score: output.toolNames[0] === SEARCH_TOOL ? 1 : 0,
          metadata:
            output.toolNames[0] === SEARCH_TOOL
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
