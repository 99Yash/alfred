/**
 * Smoke test for `system.web_search`, with no server process: the tool registers,
 * and a live grounded-Gemini call returns an answer with citations.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-web-search.ts
 */

import { DEFAULT_USER_TIMEZONE } from "@alfred/assistant/time";
import { toolExecuteContext } from "@alfred/assistant/tool-runtime/context";
import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import {
  registerSystemToolProductAdapters,
  unregisterSystemToolProductAdapters,
} from "@alfred/assistant/runtime/test-support";

async function main(): Promise<void> {
  const registry = registerBuiltinTools();
  registerSystemToolProductAdapters();

  const tool = registry.get("system.web_search");

  if (!tool) throw new Error("system.web_search did not register");
  console.log(`✓ registered: ${tool.name} (riskTier=${tool.riskTier})`);

  // SAFETY: web_search's own tool-result envelope; the smoke only logs it.
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
  unregisterSystemToolProductAdapters();

  if (!result.ok || result.answer.length === 0) {
    throw new Error("web_search returned an empty answer");
  }

  console.log("\n✅ smoke passed");
}

main().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
