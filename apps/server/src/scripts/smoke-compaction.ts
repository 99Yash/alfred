/**
 * Smoke test for m13 Phase 7 — transcript compaction (ADR-0035).
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-compaction.ts
 *
 * Runs the three fixture transcripts through the live `compactTranscript`
 * primitive (real `getCheapModel()` via `meteredGenerateText`) and asserts
 * the `mustContain` strings appear in the `<run_summary>` output.
 *
 * Fixtures live at:
 *   `packages/api/src/modules/agent/compaction/__fixtures__/*.json`
 *
 * Phase 7 acceptance is gated on all three passing. Treat a single
 * miss as a failure: the compactor system prompt almost certainly needs
 * tightening (the 7f prompt pass), not the test loosening.
 *
 * What this DOES NOT verify:
 *   - Sub-agent fail-back to the boss (exercise via a real sub-agent run
 *     with an inflated transcript; covered by `smoke-sub-agents.ts` once
 *     that smoke gains a context-pressure case).
 *   - The 3-attempt in-step retry path (a transient cheap-model failure
 *     is hard to induce deterministically; covered by code review).
 *   - The cache breakpoint hit on the second post-compaction turn
 *     (requires Anthropic; routed through Gemini today — re-verify when
 *     the spend cap clears per `packages/ai/src/provider.ts`).
 */
import { closeConnections, warmPool, verifyMeteringModels, compactTranscript } from "@alfred/api";
import { flushLangfuse } from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Fixture {
  name: string;
  description: string;
  prior: AgentTranscriptMessage[];
  inFlightTail: AgentTranscriptMessage[];
  mustContain: string[];
}

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../packages/api/src/modules/agent/compaction/__fixtures__/", import.meta.url),
);

async function loadFixtures(): Promise<Fixture[]> {
  const entries = await readdir(FIXTURES_DIR);
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const out: Fixture[] = [];
  for (const f of files) {
    const raw = await readFile(resolve(FIXTURES_DIR, f), "utf8");
    out.push(JSON.parse(raw) as Fixture);
  }
  return out;
}

async function runFixture(
  fixture: Fixture,
): Promise<{ ok: boolean; misses: string[]; text: string }> {
  console.log(`\n[smoke-compaction] running fixture: ${fixture.name}`);
  console.log(`  ${fixture.description}`);
  const result = await compactTranscript({
    prior: fixture.prior,
    inFlightTail: fixture.inFlightTail,
    attribution: {
      idempotencyKey: `smoke-compaction:${fixture.name}:${Date.now()}`,
      requestMeta: { purpose: "smoke-compaction", fixture: fixture.name },
    },
  });
  const text = result.raw.text;
  const misses = fixture.mustContain.filter((needle) => !text.includes(needle));
  const ok = misses.length === 0;
  if (ok) {
    console.log(`  ✓ ${fixture.name} — all ${fixture.mustContain.length} assertion(s) satisfied`);
  } else {
    console.log(
      `  ✗ ${fixture.name} — missing: ${misses.map((m) => JSON.stringify(m)).join(", ")}`,
    );
    console.log("  --- compactor output ---");
    console.log(text);
    console.log("  --- end output ---");
  }
  return { ok, misses, text };
}

async function main(): Promise<void> {
  await warmPool();
  await verifyMeteringModels();
  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    throw new Error(`no fixtures found in ${FIXTURES_DIR}`);
  }
  console.log(`[smoke-compaction] loaded ${fixtures.length} fixtures from ${FIXTURES_DIR}`);

  const results: Array<{ fixture: Fixture; ok: boolean; misses: string[] }> = [];
  for (const fixture of fixtures) {
    const { ok, misses } = await runFixture(fixture);
    results.push({ fixture, ok, misses });
  }

  const failed = results.filter((r) => !r.ok);
  await flushLangfuse();
  await closeConnections();

  console.log(
    `\n[smoke-compaction] summary: ${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length > 0) {
    for (const r of failed) {
      console.log(
        `  - ${r.fixture.name}: missing ${r.misses.map((m) => JSON.stringify(m)).join(", ")}`,
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-compaction] failed:", err);
  process.exit(1);
});
