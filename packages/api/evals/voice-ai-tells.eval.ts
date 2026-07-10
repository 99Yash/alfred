import path from "node:path";
import { getChatModel, getCheapModel } from "@alfred/ai";
import { generateText } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import { detectAiTells, summarizeTells } from "../src/modules/agent/voice-detector";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";
import { llmJudgeScorer } from "./lib/llm-judge";

// Behavioral guard on the shipped chat voice contract. Chat relies on the
// prompt rather than post-processing so explicit tone, persona, and exact-copy
// requests can override the default. A deterministic scorer catches
// high-confidence tells and exact-copy drift; a cheap, cross-provider judge
// verifies that concise prose is still useful and natural.
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
  exactText?: string;
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
  {
    prompt:
      "Return this sentence exactly, with no quotation marks or commentary: Ship it — after QA.",
    intent:
      "Preserve the user's exact requested copy, including its em-dash, because exact-copy instructions override Alfred's default voice.",
    exactText: "Ship it — after QA.",
  },
  {
    prompt:
      "Draft a two-sentence update for a formal board memo. Do not use contractions. Revenue grew 23% in Q3 and churn fell from 4.1% to 3.4%.",
    intent:
      "Follow the formal audience and explicit no-contractions request while staying concrete, restrained, and accurate.",
  },
];

interface TaskOutput {
  text: string;
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
    return { text: result.text };
  },
  scorers: [
    {
      name: "Voice contract in shipped prose",
      scorer: ({ input, output }) => {
        const text = output.text.trim();
        if (text.length === 0) return { score: 0, metadata: "empty output" };
        if (input.exactText !== undefined) {
          return text === input.exactText
            ? { score: 1, metadata: `exact copy preserved: ${text}` }
            : { score: 0, metadata: `expected exact copy: ${input.exactText}; received: ${text}` };
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
  trialCount: 2,
});
