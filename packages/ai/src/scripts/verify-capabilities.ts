/**
 * Capability-drift audit (ADR-0078).
 *
 * `MODEL_CAPABILITIES` (effort vocabularies + temperature support) is code-resident
 * — the provider dispatch reads it at request time, so a wrong value reintroduces
 * the #224/#303 class of silent-fallback 400. models.dev is the *audit oracle* that
 * proves those code-resident values still match reality. This script diffs the two
 * for the six registered ids and exits non-zero on drift.
 *
 * It reads the **synced `model_prices` snapshot** (`db:sync-prices` captures
 * `reasoning_options` + `temperature` into `metadata.capabilities`), NOT a live
 * models.dev fetch — so it never reddens on a provider blip and stays offline in
 * CI (honoring the triage-eval-provider-coupling lesson). Run `db:sync-prices`
 * first if a row is missing/stale. Non-gating: it's a tripwire you run after a
 * model swap, not a unit-gate.
 *
 * Run from packages/ai:
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/verify-capabilities.ts
 */
import { closeConnections, db, rowsFromExecute } from "@alfred/db";
import { sql } from "drizzle-orm";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  type ModelId,
} from "../models";

/** A reasoning-control mechanism as models.dev records it (closed 3-type set). */
interface ReasoningOption {
  type: string;
  values?: string[];
}

interface SnapshotCapabilities {
  reasoningOptions?: ReasoningOption[] | null;
  temperature?: boolean | null;
}

/**
 * Derive the expected `effortValues` from a snapshot's `reasoning_options`: the
 * `effort` mechanism's `values`, filtered to those Alfred models (i.e. anything in
 * {@link EFFORT_LEVELS}). No `effort` mechanism → `[]` (budget/toggle-only model).
 */
function expectedEffortValues(options: ReasoningOption[] | null | undefined): EffortLevel[] {
  const effort = (options ?? []).find((o) => o.type === "effort");
  if (!effort?.values) return [];
  const allowed = new Set<string>(EFFORT_LEVELS);
  return effort.values.filter((v): v is EffortLevel => allowed.has(v));
}

/** Order-insensitive set equality over effort tiers. */
function sameEfforts(a: readonly EffortLevel[], b: readonly EffortLevel[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

interface PriceRow {
  metadata: { capabilities?: SnapshotCapabilities } | null;
}

async function main() {
  const drift: string[] = [];
  const missing: string[] = [];

  for (const modelId of Object.keys(MODEL_CAPABILITIES) as ModelId[]) {
    const provider = MODEL_REGISTRY[modelId];
    const result = await db().execute(sql`
      SELECT metadata
      FROM model_prices
      WHERE provider = ${provider} AND model = ${modelId}
      ORDER BY valid_from DESC
      LIMIT 1
    `);
    const row = rowsFromExecute<PriceRow>(result)[0];
    const snapshot = row?.metadata?.capabilities;
    if (!snapshot || snapshot.reasoningOptions === undefined) {
      missing.push(
        `${modelId}: no synced capability snapshot (run \`pnpm --filter @alfred/db db:sync-prices\`)`,
      );
      continue;
    }

    const code = MODEL_CAPABILITIES[modelId];
    const oracleEfforts = expectedEffortValues(snapshot.reasoningOptions);
    if (!sameEfforts(code.effortValues, oracleEfforts)) {
      drift.push(
        `${modelId}.effortValues: code=[${code.effortValues.join(",")}] models.dev=[${oracleEfforts.join(",")}]`,
      );
    }
    // models.dev may omit `temperature`; only assert when the oracle carries it.
    if (snapshot.temperature != null && snapshot.temperature !== code.temperature) {
      drift.push(
        `${modelId}.temperature: code=${code.temperature} models.dev=${snapshot.temperature}`,
      );
    }
  }

  for (const m of missing) console.log(`⚠️  ${m}`);
  for (const d of drift) console.log(`❌ ${d}`);

  if (drift.length > 0) {
    console.log(
      `\n${drift.length} capability drift(s) — reconcile MODEL_CAPABILITIES in models.ts`,
    );
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    console.log(`\n${missing.length} model(s) had no snapshot — sync prices and re-run.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `✅ all ${Object.keys(MODEL_CAPABILITIES).length} models match models.dev (effort vocabularies + temperature)`,
  );
}

main()
  .catch((err) => {
    console.error("[verify-capabilities] FAIL:", err);
    process.exitCode = 1;
  })
  .finally(() => closeConnections().catch(() => {}));
