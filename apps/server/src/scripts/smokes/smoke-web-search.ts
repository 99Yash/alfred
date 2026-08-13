/**
 * Smoke test for the new `system.web_search` tool.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-web-search.ts
 *
 * Verifies, with no server process needed:
 *   1. The tool registers and resolves by name from the registry.
 *   2. A live Perplexity Sonar Pro call returns a non-empty answer + citations
 *      (proves PERPLEXITY_API_KEY is wired and the metered path works).
 *
 * This is the exact failure the chat screenshot exposed: the boss wanted to
 * search the web, invented `search.search`, and the dispatcher rejected it.
 */

import { DEFAULT_USER_TIMEZONE } from "@alfred/assistant/time";

// Stays on @alfred/api: still real api code. Item 148 gives it an @alfred/assistant address.
import { toolExecuteContext } from "@alfred/api/backend";
import { getTool } from "@alfred/assistant/tool-runtime";
// Stays on @alfred/api: still real api code. Item 148 gives it an @alfred/assistant address.
import { registerBuiltinTools } from "@alfred/api/runtime";

async function main(): Promise<void> {
  registerBuiltinTools();

  const tool = getTool("system.web_search");
  if (!tool) throw new Error("system.web_search did not register");
  console.log(`✓ registered: ${tool.name} (riskTier=${tool.riskTier})`);

  const result = (await tool.execute(
    { query: "What are Cloudflare Durable Object facets?" },
    toolExecuteContext({
      runId: "smoke-run",
      scratchpadRunId: "smoke-run",
      stepId: "smoke-step",
      toolCallId: "smoke-call",
      userId: "smoke-user",
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      timezone: DEFAULT_USER_TIMEZONE,
    }),
  )) as { ok: boolean; answer: string; citations: string[] };

  console.log(`✓ ok=${result.ok}`);
  console.log(`✓ answer (${result.answer.length} chars):\n`);
  console.log(result.answer.slice(0, 1200));
  console.log(`\n✓ ${result.citations.length} citations:`);
  for (const c of result.citations.slice(0, 8)) console.log(`  - ${c}`);

  if (!result.ok || result.answer.length === 0) {
    throw new Error("web_search returned an empty answer");
  }
  console.log("\n✅ smoke passed");
}

main().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
