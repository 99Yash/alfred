/**
 * Capability-drift audit (ADR-0078).
 *
 * `MODEL_CAPABILITIES` (effort vocabularies + temperature support) is code-resident
 * — the provider dispatch reads it at request time, so a wrong value reintroduces
 * the #224/#303 class of silent-fallback 400. models.dev is the *audit oracle* that
 * proves those code-resident values still match reality. This script diffs the two
 * for every registered id and exits non-zero on drift.
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
import { z } from "zod";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  type ModelId,
} from "../models";

const reasoningOptionSchema = z
  .object({
    type: z.string(),
    values: z.array(z.string()).optional(),
  })
  .passthrough();

/** A reasoning-control mechanism as models.dev records it (closed 3-type set). */
type ReasoningOption = z.infer<typeof reasoningOptionSchema>;

const snapshotCapabilitiesSchema = z
  .object({
    reasoningOptions: z.array(reasoningOptionSchema).nullable().optional(),
    temperature: z.boolean().nullable().optional(),
  })
  .passthrough();

type SnapshotCapabilities = z.infer<typeof snapshotCapabilitiesSchema>;

const snapshotMetadataSchema = z
  .object({
    capabilities: snapshotCapabilitiesSchema.optional(),
  })
  .passthrough();

const knownEffortLevels: ReadonlySet<string> = new Set(EFFORT_LEVELS);

function isEffortLevel(value: string): value is EffortLevel {
  return knownEffortLevels.has(value);
}

/**
 * Derive the expected `effortValues` from a snapshot's `reasoning_options`: the
 * `effort` mechanism's `values`. Unknown provider values are returned as drift,
 * never filtered out, because dropping `minimal`/`none` would green-light the
 * exact vocabulary mismatch this audit exists to catch.
 */
function expectedEffortValues(options: ReasoningOption[] | null | undefined): {
  values: EffortLevel[];
  unknown: string[];
} {
  const effort = (options ?? []).find((o) => o.type === "effort");
  if (!effort?.values) return { values: [], unknown: [] };
  const values: EffortLevel[] = [];
  const unknown: string[] = [];
  for (const value of effort.values) {
    if (isEffortLevel(value)) values.push(value);
    else unknown.push(value);
  }
  return { values, unknown };
}

/** Order-sensitive equality over effort tiers; clamp relies on weakest→strongest ordering. */
function sameEfforts(a: readonly EffortLevel[], b: readonly EffortLevel[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface PriceRow {
  metadata: unknown;
}

type SnapshotResult =
  | { kind: "ok"; snapshot: SnapshotCapabilities }
  | { kind: "missing"; message: string }
  | { kind: "malformed"; message: string };

function missingSnapshotMessage(modelId: ModelId): string {
  return `${modelId}: no synced capability snapshot (run \`pnpm --filter @alfred/db db:sync-prices\`)`;
}

function readSnapshot(modelId: ModelId, metadata: unknown): SnapshotResult {
  if (metadata == null) {
    return { kind: "missing", message: missingSnapshotMessage(modelId) };
  }

  const parsed = snapshotMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return {
      kind: "malformed",
      message: `${modelId}.metadata: malformed capability snapshot: ${z.prettifyError(parsed.error)}`,
    };
  }

  const snapshot = parsed.data.capabilities;
  if (!snapshot || snapshot.reasoningOptions === undefined) {
    return { kind: "missing", message: missingSnapshotMessage(modelId) };
  }
  return { kind: "ok", snapshot };
}

function directErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === "string" ? err : undefined;
}

function aggregateErrorMessages(err: unknown): string[] {
  if (!(err instanceof Error) || !("errors" in err)) return [];
  const errors = err.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((nested) => {
    const message = directErrorMessage(nested);
    return message ? [message] : [];
  });
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = "cause" in err ? err.cause : undefined;
  const aggregateMessages = aggregateErrorMessages(cause);
  const causeMessage =
    aggregateMessages.length > 0 ? aggregateMessages.join("; ") : directErrorMessage(cause);
  return causeMessage ? `${err.message}; cause: ${causeMessage}` : err.message;
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
    const parsed = readSnapshot(modelId, row?.metadata ?? null);
    if (parsed.kind === "missing") {
      missing.push(parsed.message);
      continue;
    }
    if (parsed.kind === "malformed") {
      drift.push(parsed.message);
      continue;
    }
    const { snapshot } = parsed;

    const code = MODEL_CAPABILITIES[modelId];
    const oracleEfforts = expectedEffortValues(snapshot.reasoningOptions);
    if (oracleEfforts.unknown.length > 0) {
      drift.push(
        `${modelId}.effortValues: models.dev exposed unknown value(s) [${oracleEfforts.unknown.join(",")}] — add them to EFFORT_LEVELS before comparing`,
      );
      continue;
    }
    if (!sameEfforts(code.effortValues, oracleEfforts.values)) {
      drift.push(
        `${modelId}.effortValues: code=[${code.effortValues.join(",")}] models.dev=[${oracleEfforts.values.join(",")}]`,
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
    console.error("[verify-capabilities] FAIL:", errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => closeConnections().catch(() => {}));
