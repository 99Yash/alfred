import path from "node:path";
import { getChatModel } from "@alfred/ai";
import { gmailSearchInput, rememberInput, resolveTodoInput } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

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

interface TaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

interface Case {
  input: string;
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
    system: SYSTEM,
    prompt: input,
    temperature: 0,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
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

evalite<string, TaskOutput, null>("Agent sender-suppression grounding — search before ask", {
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
});
