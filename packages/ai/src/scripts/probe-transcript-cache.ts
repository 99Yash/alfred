/**
 * Live proof that the transcript cache breakpoint (#223) lands cache *reads*,
 * not just writes. No server / DB needed — a direct Anthropic call.
 *
 *   $ ANTHROPIC_API_KEY=… pnpm --filter @alfred/ai exec tsx src/scripts/probe-transcript-cache.ts
 *   (or run from repo root with --env-file=apps/server/.env)
 *
 * Reproduces what AlfredAgent does — a cacheControl breakpoint on the system
 * block AND on the last transcript message (decorateTranscript) — then calls
 * the real model twice with a growing transcript:
 *
 *   Turn 1 (cold): expect cache_creation ≈ system+transcript, cache_read = 0.
 *   Turn 2 (warm): append two messages, move the breakpoint to the new last
 *                  message → expect cache_read ≈ the turn-1 prefix (the win),
 *                  cache_creation ≈ only the appended delta.
 *
 * If turn 2's cache_read is ~0, transcript caching is NOT working.
 */

// NOTE: this probe deliberately bypasses the package's model-dispatch helpers and
// reads `process.env` directly. The whole point is to isolate the raw Anthropic
// cache accounting from the agent stack — `getChatModel()` would pull in fallback
// wrapping, and `serverEnv()` would throw on ~19 unrelated vars a bare probe has no
// business requiring. Do not "fix" this to route through the helpers.
import { anthropic } from "@ai-sdk/anthropic";
import { getPath, toRecord } from "@alfred/contracts";
import { generateText, type ModelMessage } from "ai";
import { decorateTranscript } from "../agent.js";

const TTL = "5m" as const;
const GENERATE_TIMEOUT_MS = 60_000;

// A stable, sizable first message so the prefix clears Anthropic's ~1024-token
// minimum cacheable size. Deterministic content (no timestamps) so the prefix
// is byte-identical across the two turns.
const FILLER = Array.from(
  { length: 400 },
  (_, i) => `Reference note ${i}: the quick brown fox jumps over the lazy dog near the riverbank.`,
).join(" ");

const systemBlock = {
  role: "system" as const,
  content:
    "You are a terse test assistant. Reply with a single short sentence. " +
    "Here is durable context you must keep in mind: " +
    FILLER,
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: TTL } } },
};

function cacheStats(meta: unknown): { read: number; created: number } {
  // Anthropic reports cache accounting under providerMetadata.anthropic.usage
  // (snake_case). Standardized cache usage lives on `res.usage.inputTokenDetails`.
  const usage = toRecord(getPath(meta, "anthropic", "usage"));
  return {
    read: Number(usage.cache_read_input_tokens ?? 0),
    created: Number(usage.cache_creation_input_tokens ?? 0),
  };
}

async function turn(label: string, transcript: ModelMessage[]): Promise<void> {
  const res = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    instructions: systemBlock,
    messages: decorateTranscript(transcript, TTL),
    maxOutputTokens: 64,
    temperature: 0,
    timeout: GENERATE_TIMEOUT_MS,
  });
  const { read, created } = cacheStats(res.finalStep.providerMetadata);
  console.log(
    `${label}: input=${res.usage.inputTokens} usage.cached=${res.usage.inputTokenDetails?.cacheReadTokens ?? "?"} cached_read=${read} cache_created=${created} → "${res.text.slice(0, 50)}"`,
  );
  console.log(
    `   raw anthropic meta: ${JSON.stringify(res.finalStep.providerMetadata?.anthropic)}`,
  );
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const base: ModelMessage[] = [
    { role: "user", content: "Given the context, what animal is mentioned in the notes?" },
  ];

  await turn("turn 1 (cold)", base);

  // Append the assistant's prior answer + a follow-up — what a real turn 2 looks
  // like after a tool round. The turn-1 prefix is now a strict prefix.
  const grown: ModelMessage[] = [
    ...base,
    { role: "assistant", content: "A fox is mentioned." },
    { role: "user", content: "And what does it jump over?" },
  ];
  await turn("turn 2 (warm)", grown);

  console.log(
    "\nExpect turn 2 cached_read to be large (≈ the turn-1 prefix). If it's ~0, transcript caching is broken.",
  );
}

main().catch((err) => {
  console.error("❌ probe failed:", err);
  process.exit(1);
});
