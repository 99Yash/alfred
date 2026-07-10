import path from "node:path";
import { getChatModel } from "@alfred/ai";
import { generateText } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { detectAiTells, summarizeTells } from "../src/modules/agent/voice-detector";
import { sanitizeVoice } from "../src/modules/agent/voice-sanitize";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";

// GROUND: behavioral guard on the SHIPPED chat voice contract, which is two
// layers: DEFAULT_VOICE_PROMPT (suppresses the judgment tells) plus the
// deterministic sanitizeVoice pass the chat stream runs (strips em-dashes the
// model won't drop on its own). The task mirrors that contract — generate a real
// reply under the live chat system prompt, then sanitize — and runs the detector
// over the result. The prompts below TEMPT the forbidden register: a
// congratulation invites flattery/emoji, a "motivate me" invites hype and generic
// conclusions, an "explain what you do" invites marketing voice. A tell surviving
// means the fragment rotted out of the prompt, the sanitizer regressed, or a model
// swap changed the voice.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY, matching
// serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-06-26T04:44:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message, gmail.send_draft — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

// Prompts that do NOT need a tool call (so the model replies in prose) but do
// tempt the forbidden register.
const CASES: string[] = [
  "I just shipped the release I've been grinding on for two weeks. Say something.",
  "Give me a one-line boost before I walk into a big client demo.",
  "In a couple of sentences, tell me what you can help me with day to day.",
  "Why should I bother keeping my inbox at zero? Keep it short.",
  "My deploy just failed for the third time today. Say something short and real.",
];

interface TaskOutput {
  text: string;
}

evalite<string, TaskOutput>("Chat voice — no AI-writing tells", {
  data: () => CASES.map((input) => ({ input })),
  task: async (input): Promise<TaskOutput> => {
    const result = await generateText({
      model: getChatModel("standard"),
      system: SYSTEM,
      prompt: input,
      temperature: 0.3,
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
    });
    // Mirror the shipped chat path: the stream runs sanitizeVoice on every delta.
    return { text: sanitizeVoice(result.text) };
  },
  scorers: [
    {
      // Deterministic + pure: never throws, so a flaky generation can't hang
      // the reporter (see evals/lib/llm-judge.ts). Empty output has no tells and
      // scores clean; the metadata flags it so a human notices a dead generation.
      name: "No AI-writing tells in shipped prose",
      scorer: ({ output }) => {
        const text = output.text.trim();
        if (text.length === 0) {
          return { score: 1, metadata: "empty output, nothing generated to score" };
        }
        const tells = detectAiTells(text);
        return {
          score: tells.length === 0 ? 1 : 0,
          metadata:
            tells.length === 0
              ? `clean: ${text.slice(0, 150)}`
              : `${summarizeTells(tells)} in: ${text.slice(0, 150)}`,
        };
      },
    },
  ],
});
