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
import { db } from "../index";
import { modelPrices } from "../schema/metering";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Providers we care about. Anything else from models.dev is ignored. */
const PROVIDERS = ["anthropic", "google", "openai", "perplexity"] as const;

interface ModelsDevModel {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number };
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
  },
  {
    provider: "voyage",
    model: "voyage-3.5",
    inputPerMtok: 0.06,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    perCallUsd: null,
  },
  {
    provider: "voyage",
    model: "rerank-2.5-lite",
    inputPerMtok: 0.05,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    perCallUsd: null,
  },
];

interface PriceRow {
  provider: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
  source: string;
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
        source: "models.dev",
      });
    }
  }
  return rows;
}

function pricesEqual(
  a: { inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok: number | null; perCallUsd: number | null },
  b: { inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok: number | null; perCallUsd: number | null },
): boolean {
  return (
    a.inputPerMtok === b.inputPerMtok &&
    a.outputPerMtok === b.outputPerMtok &&
    a.cachedInputPerMtok === b.cachedInputPerMtok &&
    a.perCallUsd === b.perCallUsd
  );
}

async function upsertIfChanged(row: PriceRow): Promise<"inserted" | "unchanged"> {
  const existing = await db().execute(sql`
    SELECT input_per_mtok, output_per_mtok, cached_input_per_mtok, per_call_usd
    FROM model_prices
    WHERE provider = ${row.provider} AND model = ${row.model}
    ORDER BY valid_from DESC
    LIMIT 1
  `);
  const rawRows = (existing as { rows?: unknown[] }).rows ?? (existing as unknown as unknown[]);
  const latest = (Array.isArray(rawRows) ? rawRows[0] : undefined) as
    | {
        input_per_mtok: string;
        output_per_mtok: string;
        cached_input_per_mtok: string | null;
        per_call_usd: string | null;
      }
    | undefined;

  if (latest) {
    const same = pricesEqual(
      {
        inputPerMtok: Number(latest.input_per_mtok),
        outputPerMtok: Number(latest.output_per_mtok),
        cachedInputPerMtok:
          latest.cached_input_per_mtok != null ? Number(latest.cached_input_per_mtok) : null,
        perCallUsd: latest.per_call_usd != null ? Number(latest.per_call_usd) : null,
      },
      row,
    );
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
      metadata: { source: row.source },
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
    if (err instanceof Error && "cause" in err) console.error("[sync-prices] cause:", (err as { cause?: unknown }).cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeConnections } = await import("../index");
    await closeConnections().catch(() => {});
  });
