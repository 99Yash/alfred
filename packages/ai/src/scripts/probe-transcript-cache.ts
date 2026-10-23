/**
 * Live check that the transcript cache breakpoint produces cache reads. Calls Anthropic through
 * the Cloudflare gateway.
 *
 *   $ pnpm --filter @alfred/ai exec tsx --env-file=../../apps/server/.env src/scripts/probe-transcript-cache.ts
 *
 * Turn 2 must read about the turn-1 prefix from cache. A read near 0 means caching is broken.
 */

// Bypasses `route()` on purpose: it measures raw Anthropic caching, without fallback wrapping.
import { getPath, toRecord } from "@alfred/contracts";
import { generateText, type ModelMessage } from "ai";
import { activeGateway } from "../gateway";
import { attachProviderTurnPolicy, adaptProviderModel } from "../provider-adapter";

const TTL = "5m" as const;

const GENERATE_TIMEOUT_MS = 60_000;

// Fixed text over Anthropic's ~1024-token cache minimum, identical on both turns.
const FILLER = Array.from(
  { length: 400 },
  (_, i) => `Reference note ${i}: the quick brown fox jumps over the lazy dog near the riverbank.`,
).join(" ");

const systemBlock =
  "You are a terse test assistant. Reply with a single short sentence. " +
  "Here is durable context you must keep in mind: " +
  FILLER;

const model = adaptProviderModel(
  "anthropic",
  activeGateway().createAnthropic()("claude-sonnet-4-6"),
).model;

function cacheStats(meta: unknown) {
  // Anthropic's raw, snake_case cache numbers.
  const usage = toRecord(getPath(meta, "anthropic", "usage"));

  return {
    read: Number(usage.cache_read_input_tokens ?? 0),
    created: Number(usage.cache_creation_input_tokens ?? 0),
  };
}

async function turn(label: string, transcript: ModelMessage[]): Promise<void> {
  const res = await generateText({
    model,
    instructions: systemBlock,
    messages: transcript,
    providerOptions: attachProviderTurnPolicy(undefined, TTL),
    maxOutputTokens: 64,
    temperature: 0,
    timeout: GENERATE_TIMEOUT_MS,
  });

  const { read, created } = cacheStats(res.finalStep.providerMetadata);
  console.log(
    `${label}: input=${res.usage.inputTokens} usage.cached=${res.usage.inputTokenDetails.cacheReadTokens ?? "?"} cached_read=${read} cache_created=${created} → "${res.text.slice(0, 50)}"`,
  );
  console.log(
    `   raw anthropic meta: ${JSON.stringify(res.finalStep.providerMetadata?.anthropic)}`,
  );
}

async function main(): Promise<void> {
  const base: ModelMessage[] = [
    { role: "user", content: "Given the context, what animal is mentioned in the notes?" },
  ];

  await turn("turn 1 (cold)", base);

  // Append an answer and a follow-up, so turn 1 is a strict prefix.
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
