/**
 * Run fixture transcripts through the live `compactTranscript` (ADR-0035) and check
 * each `<run_summary>` section. Fixtures: `packages/assistant/src/execution/run-compaction/__fixtures__/*.json`.
 * Treat one miss as a failure: tighten the compactor prompt, not the check.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-compaction.ts
 */
import {
  compactTranscript,
  assertHandoffSections,
  extractHandoffSection,
  HANDOFF_SECTIONS,
} from "@alfred/assistant/execution/run-compaction/index";
import { closeConnections, warmPool } from "@alfred/db";
import { verifyMeteringModels } from "@alfred/assistant/execution";
import { flushLangfuse } from "@alfred/ai";
import { jsonObjectSchema, parseJsonText } from "@alfred/contracts";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toMessage } from "@alfred/contracts";
import { z } from "zod";

const transcriptMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
  providerOptions: jsonObjectSchema.optional(),
});

/** One check on a section: it must contain one string, or it must not contain one. */
const fixtureAssertionSchema = z
  .object({
    section: z.enum(HANDOFF_SECTIONS),
    contains: z.string().optional(),
    absent: z.string().optional(),
  })
  .refine((assertion) => (assertion.contains === undefined) !== (assertion.absent === undefined), {
    message: "an assertion sets exactly one of contains and absent",
  });

const fixtureSchema = z.object({
  name: z.string(),
  description: z.string(),
  prior: z.array(transcriptMessageSchema),
  inFlightTail: z.array(transcriptMessageSchema),
  assertions: z.array(fixtureAssertionSchema),
});

type Fixture = z.infer<typeof fixtureSchema>;

type FixtureAssertion = z.infer<typeof fixtureAssertionSchema>;

const FIXTURES_DIR = fileURLToPath(
  new URL(
    "../../../../../packages/assistant/src/execution/run-compaction/__fixtures__/",
    import.meta.url,
  ),
);

const RUNS_PER_FIXTURE = 5;

async function loadFixtures(): Promise<Fixture[]> {
  const entries = await readdir(FIXTURES_DIR);
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const out: Fixture[] = [];

  for (const f of files) {
    const raw = await readFile(resolve(FIXTURES_DIR, f), "utf8");
    out.push(fixtureSchema.parse(parseJsonText(raw)));
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
  const misses = collectMisses(text, fixture.assertions);
  const ok = misses.length === 0;

  if (ok) {
    console.log(`  ✓ ${fixture.name} — all ${fixture.assertions.length} assertion(s) satisfied`);
  } else {
    console.log(`  ✗ ${fixture.name} — failed: ${misses.map((m) => JSON.stringify(m)).join(", ")}`);
    console.log("  --- compactor output ---");
    console.log(text);
    console.log("  --- end output ---");
  }

  return { ok, misses, text };
}

function collectMisses(text: string, assertions: FixtureAssertion[]): string[] {
  const misses: string[] = [];

  try {
    assertHandoffSections(text);
  } catch (err) {
    misses.push(toMessage(err));
  }

  for (const assertion of assertions) {
    const section = extractHandoffSection(text, assertion.section);

    if (section === null) {
      misses.push(`${assertion.section}: section missing`);
      continue;
    }

    if (assertion.contains !== undefined && !section.includes(assertion.contains)) {
      misses.push(`${assertion.section}: missing ${JSON.stringify(assertion.contains)}`);
    }

    if (assertion.absent !== undefined && section.includes(assertion.absent)) {
      misses.push(
        `${assertion.section}: unexpectedly contained ${JSON.stringify(assertion.absent)}`,
      );
    }
  }

  return misses;
}

async function main(): Promise<void> {
  await warmPool();
  await verifyMeteringModels();
  const fixtures = await loadFixtures();

  if (fixtures.length === 0) {
    throw new Error(`no fixtures found in ${FIXTURES_DIR}`);
  }

  console.log(
    `[smoke-compaction] loaded ${fixtures.length} fixtures from ${FIXTURES_DIR}; runs=${RUNS_PER_FIXTURE}`,
  );

  const results: Array<{ fixture: Fixture; ok: boolean; misses: string[] }> = [];

  for (const fixture of fixtures) {
    for (let run = 1; run <= RUNS_PER_FIXTURE; run++) {
      console.log(`[smoke-compaction] fixture ${fixture.name}, run ${run}/${RUNS_PER_FIXTURE}`);
      const { ok, misses } = await runFixture(fixture);
      results.push({ fixture, ok, misses });
    }
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
