import path from "node:path";
import { getChatModel, getCheapModel } from "@alfred/ai";
import { generateText } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { detectAiTells, summarizeTells } from "../src/modules/agent/voice-detector";
import { createVoiceStreamSanitizer } from "../src/modules/agent/voice-sanitize";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";
import { llmJudgeScorer } from "./lib/llm-judge";

// Behavioral guard on the shipped chat voice contract. It grades both layers:
// DEFAULT_VOICE_PROMPT suppresses judgment-based tells, while the streaming
// sanitizer enforces the user's punctuation preference without corrupting code
// or quotes. A deterministic scorer catches high-confidence tells; a cheap,
// cross-provider judge verifies that terse prose is still useful and human.
//
// Run locally with apps/server/.env populated:
// `pnpm --filter @alfred/api eval`.

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

interface Case {
  prompt: string;
  intent: string;
}

const CASES: Case[] = [
  {
    prompt: "I just shipped the release I've been grinding on for two weeks. Say something.",
    intent: "Acknowledge a meaningful win with specific, natural warmth; do not sound ceremonial.",
  },
  {
    prompt: "Give me a one-line boost before I walk into a big client demo.",
    intent:
      "Give one concise, credible line of encouragement rather than generic motivational hype.",
  },
  {
    prompt: "In a couple of sentences, tell me what you can help me with day to day.",
    intent:
      "Explain concrete everyday help in no more than a few direct sentences without marketing copy.",
  },
  {
    prompt: "Why should I bother keeping my inbox at zero? Keep it short.",
    intent:
      "Answer the premise honestly and briefly; it is acceptable to reject inbox zero as a goal.",
  },
  {
    prompt: "My deploy just failed for the third time today. Say something short and real.",
    intent:
      "Respond with concise empathy that feels human without flattery, canned reassurance, or hype.",
  },
];

interface TaskOutput {
  text: string;
}

function sanitizeAsStream(text: string): string {
  const sanitizer = createVoiceStreamSanitizer();
  let output = "";
  // Exercise arbitrary provider boundaries, including delimiters split one
  // character at a time. This is intentionally harsher than a typical stream.
  for (const char of text) output += sanitizer.push(char);
  return output + sanitizer.flush();
}

const QUALITY_RUBRIC = `
A: Fully answers the stated intent, is concise and specific, sounds natural for the emotional context, and preserves the user's requested length and tone.
B: Useful and mostly natural, but has one minor issue such as slightly generic wording, mild coldness, or avoidable length.
C: Partly answers but is noticeably generic, cold, verbose, evasive, or weakly aligned with the requested tone.
D: Empty, unhelpful, off-task, meaningfully patronizing, or violates the requested form or length.
Do not reward terseness by itself. A short response that fails to help or acknowledge the situation is a failure.`;

evalite<Case, TaskOutput>("Chat voice — direct, human, and useful", {
  data: () => CASES.map((input) => ({ input })),
  task: async (input): Promise<TaskOutput> => {
    const result = await generateText({
      model: getChatModel("standard"),
      system: SYSTEM,
      prompt: input.prompt,
      temperature: 0.3,
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
    });
    return { text: sanitizeAsStream(result.text) };
  },
  scorers: [
    {
      name: "No AI-writing tells in shipped prose",
      scorer: ({ output }) => {
        const text = output.text.trim();
        if (text.length === 0) return { score: 0, metadata: "empty output" };
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
    llmJudgeScorer<Case, TaskOutput, never>({
      name: "Useful and natural",
      rubric: QUALITY_RUBRIC,
      // Generation is Claude; use cheap Gemini as the judge to reduce spend and
      // avoid same-model-family preference.
      model: getCheapModel(),
      skipWhen: ({ output }) => (output.text.trim().length === 0 ? "empty output" : null),
      prompt: ({ input, output }) =>
        [
          "User prompt:",
          input.prompt,
          "",
          "Intended product outcome:",
          input.intent,
          "",
          "Assistant response:",
          output.text,
          "",
          "Grade the response against the rubric and intended outcome.",
        ].join("\n"),
    }),
  ],
  trialCount: 1,
});
