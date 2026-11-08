/**
 * One live turn probe of the `compactor` leg (Anthropic Haiku 5.5) through the Cloudflare
 * AI Gateway: asks for a tiny `<run_summary>` and prints usage and the resolved context
 * window. The compactor validates output shape upstream, so the probe emits the same
 * wrapper to confirm the leg is talking the real route, not a hand-built model.
 *
 * Run locally (needs serverEnv gateway vars) from apps/server; tsx keeps sockets open,
 * so background it and read the redirected output:
 *   cd apps/server && (./node_modules/.bin/tsx --env-file=.env \
 *     src/scripts/probes/probe-compactor-haiku.ts > /tmp/haiku-probe.log 2>&1 &)
 */
import { anthropicLeg, probeRoute, resolveContextWindowById } from "@alfred/ai";
import { generateText } from "ai";

const model = probeRoute(anthropicLeg("claude-haiku-5-5"), "none");

const result = await generateText({
  model: model.model(),
  maxOutputTokens: 100,
  instructions: "Reply with exactly one <run_summary></run_summary> element and nothing else.",
  messages: [
    {
      role: "user",
      content: "Compact: turns 1-3: user asked for a calendar summary; 3 events found.",
    },
  ],
});

const window = await resolveContextWindowById("anthropic", "claude-haiku-5-5");

const lastStep = result.steps[result.steps.length - 1];

console.log({
  text: JSON.stringify(result.text.slice(0, 120)),
  modelId: lastStep.response.modelId,
  stopReason: result.finishReason,
  usage: result.usage,
  fallbackWindow: window,
});
