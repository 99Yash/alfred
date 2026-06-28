/**
 * Pull current model pricing from models.dev and upsert into `model_prices`
 * with today's `valid_from`. Per ADR-0016: models.dev is the canonical
 * registry; pinning specific SKUs at implementation time (not in ADRs).
 *
 *   $ pnpm --filter @alfred/db db:sync-prices
 *
 * The script is idempotent within a day: re-running creates a new
 * `valid_from` row only if pricing actually changed (we compare the
 * latest row to the incoming numbers and skip equal rows).
 *
 * Voyage isn't in models.dev — those rows come from a static fallback
 * below until they're added or we wire a Voyage-specific source.
 */
import { sql } from "drizzle-orm";
import { db, rowsFromExecute } from "../index";
import { modelPrices } from "../schema/metering";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Providers we care about. Anything else from models.dev is ignored. */
const PROVIDERS = ["anthropic", "google", "openai", "perplexity"] as const;

/**
 * A single reasoning-control mechanism from models.dev. The catalog-wide universe
 * is a closed 3-type set (`effort` | `budget_tokens` | `toggle`); `values` is
 * present only on `effort` (the vocabulary the `verify-capabilities` audit diffs
 * against `MODEL_CAPABILITIES.effortValues`).
 */
interface ModelsDevReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

interface ModelsDevModel {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number };
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  temperature?: boolean;
  tool_call?: boolean;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** Static fallback for providers absent from models.dev. Per-Mtok USD. */
const STATIC_PRICES: Array<{
  provider: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
  contextWindow: number | null;
  metadata?: Record<string, unknown>;
}> = [
  // Voyage embeddings (https://www.voyageai.com/pricing/, retrieved 2026-04-30).
  // Voyage charges per input token only; output tokens not applicable.
  {
    provider: "voyage",
    model: "voyage-context-3",
    inputPerMtok: 0.18,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    perCallUsd: null,
    contextWindow: null,
  },
  {
    provider: "voyage",
    model: "voyage-3.5",
    inputPerMtok: 0.06,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    perCallUsd: null,
    contextWindow: null,
  },
  {
    provider: "voyage",
    model: "rerank-2.5-lite",
    inputPerMtok: 0.05,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    perCallUsd: null,
    contextWindow: null,
  },
];

interface PriceRow {
  provider: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
  contextWindow: number | null;
  source: string;
  metadata?: Record<string, unknown>;
}

async function fetchCatalog(): Promise<ModelsDevCatalog> {
  const res = await fetch(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  return (await res.json()) as ModelsDevCatalog;
}

function flattenCatalog(catalog: ModelsDevCatalog): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const provider of PROVIDERS) {
    const models = catalog[provider]?.models;
    if (!models) continue;
    for (const [id, m] of Object.entries(models)) {
      const cost = m.cost;
      if (!cost) continue;
      if (cost.input == null || cost.output == null) continue;
      rows.push({
        provider,
        model: id,
        inputPerMtok: cost.input,
        outputPerMtok: cost.output,
        cachedInputPerMtok: cost.cache_read ?? null,
        perCallUsd: null,
        contextWindow: m.limit?.context ?? null,
        source: "models.dev",
        metadata: {
          capabilities: {
            reasoning: m.reasoning ?? false,
            toolCall: m.tool_call ?? false,
            // Captured for the `verify-capabilities` audit (ADR-0078): the per-
            // model effort vocabulary + temperature support that `@alfred/ai`'s
            // `MODEL_CAPABILITIES` hard-codes. models.dev is the *audit oracle*,
            // not a runtime source — the audit diffs the snapshot against the
            // code-resident values and fails on drift.
            reasoningOptions: m.reasoning_options ?? null,
            temperature: m.temperature ?? null,
          },
          limit: m.limit ?? null,
          modalities: m.modalities ?? null,
        },
      });
    }
  }
  return rows;
}

function pricesEqual(
  a: {
    inputPerMtok: number;
    outputPerMtok: number;
    cachedInputPerMtok: number | null;
    perCallUsd: number | null;
    contextWindow: number | null;
  },
  b: {
    inputPerMtok: number;
    outputPerMtok: number;
    cachedInputPerMtok: number | null;
    perCallUsd: number | null;
    contextWindow: number | null;
  },
): boolean {
  return (
    a.inputPerMtok === b.inputPerMtok &&
    a.outputPerMtok === b.outputPerMtok &&
    a.cachedInputPerMtok === b.cachedInputPerMtok &&
    a.perCallUsd === b.perCallUsd &&
    a.contextWindow === b.contextWindow
  );
}

/**
 * Compare the audited capability subset (effort vocabulary + temperature) the
 * `verify-capabilities` script reads. Folded into change-detection so a
 * capability shift inserts a fresh snapshot even when *price* is unchanged —
 * otherwise the new metadata would never land on a price-stable model and the
 * audit would perpetually see no snapshot. Deep-compared via JSON (the tracked
 * fields are a small array + a boolean), order-sensitive (models.dev is stable).
 */
function capabilitiesEqual(
  latestMetadata: unknown,
  incoming: Record<string, unknown> | undefined,
): boolean {
  const pick = (meta: unknown) => {
    const caps = (meta as { capabilities?: Record<string, unknown> } | null)?.capabilities;
    return JSON.stringify({
      reasoningOptions: caps?.reasoningOptions ?? null,
      temperature: caps?.temperature ?? null,
    });
  };
  return pick(latestMetadata) === pick(incoming);
}

async function upsertIfChanged(row: PriceRow): Promise<"inserted" | "unchanged"> {
  const existing = await db().execute(sql`
    SELECT input_per_mtok, output_per_mtok, cached_input_per_mtok, per_call_usd, context_window, metadata
    FROM model_prices
    WHERE provider = ${row.provider} AND model = ${row.model}
    ORDER BY valid_from DESC
    LIMIT 1
  `);
  const latest = rowsFromExecute<{
    input_per_mtok: string;
    output_per_mtok: string;
    cached_input_per_mtok: string | null;
    per_call_usd: string | null;
    context_window: number | null;
    metadata: unknown;
  }>(existing)[0];

  if (latest) {
    const same =
      pricesEqual(
        {
          inputPerMtok: Number(latest.input_per_mtok),
          outputPerMtok: Number(latest.output_per_mtok),
          cachedInputPerMtok:
            latest.cached_input_per_mtok != null ? Number(latest.cached_input_per_mtok) : null,
          perCallUsd: latest.per_call_usd != null ? Number(latest.per_call_usd) : null,
          contextWindow: latest.context_window,
        },
        row,
      ) && capabilitiesEqual(latest.metadata, row.metadata);
    if (same) return "unchanged";
  }

  await db()
    .insert(modelPrices)
    .values({
      provider: row.provider,
      model: row.model,
      inputPerMtok: row.inputPerMtok.toString(),
      outputPerMtok: row.outputPerMtok.toString(),
      cachedInputPerMtok: row.cachedInputPerMtok != null ? row.cachedInputPerMtok.toString() : null,
      perCallUsd: row.perCallUsd != null ? row.perCallUsd.toString() : null,
      contextWindow: row.contextWindow,
      metadata: { source: row.source, ...row.metadata },
    });
  return "inserted";
}

async function main() {
  console.log("[sync-prices] fetching models.dev…");
  const catalog = await fetchCatalog();
  const fromCatalog = flattenCatalog(catalog);
  const fromStatic = STATIC_PRICES.map((r) => ({ ...r, source: "static" }));
  const all = [...fromCatalog, ...fromStatic];
  console.log(`[sync-prices] ${fromCatalog.length} from models.dev + ${fromStatic.length} static`);

  let inserted = 0;
  let unchanged = 0;
  for (const row of all) {
    const result = await upsertIfChanged(row);
    if (result === "inserted") inserted++;
    else unchanged++;
  }
  console.log(`[sync-prices] inserted=${inserted} unchanged=${unchanged}`);
}

main()
  .catch((err) => {
    console.error("[sync-prices] FAIL:", err);
    if (err instanceof Error && "cause" in err)
      console.error("[sync-prices] cause:", (err as { cause?: unknown }).cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeConnections } = await import("../index");
    await closeConnections().catch(() => {});
  });
