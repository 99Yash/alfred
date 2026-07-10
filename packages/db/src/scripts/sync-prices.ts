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
import { httpErrorFromResponse, isRecord } from "@alfred/contracts";
import type { ModelPricingMetadata } from "@alfred/contracts/model-pricing";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, rowsFromExecute } from "../index";
import { modelPrices } from "../schema/metering";

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_FETCH_TIMEOUT_MS = 30_000;

/** Providers we care about. Anything else from models.dev is ignored. */
const PROVIDERS = ["anthropic", "google", "openai", "perplexity"] as const;

/**
 * A single reasoning-control mechanism from models.dev. The catalog-wide universe
 * is a closed 3-type set (`effort` | `budget_tokens` | `toggle`); `values` is
 * present only on `effort` (the vocabulary the `verify-capabilities` audit diffs
 * against `MODEL_CAPABILITIES.effortValues`).
 */
const modelsDevReasoningOptionSchema = z
  .object({
    type: z.string(),
    values: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .passthrough();

const modelsDevCostTierSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
    tier: z.object({ type: z.literal("context"), size: z.number().int().positive() }).passthrough(),
  })
  .passthrough();

const modelsDevModelSchema = z
  .object({
    id: z.string(),
    cost: z
      .object({
        input: z.number().nonnegative().optional(),
        output: z.number().nonnegative().optional(),
        cache_read: z.number().nonnegative().optional(),
        cache_write: z.number().nonnegative().optional(),
        tiers: z.array(modelsDevCostTierSchema).optional(),
      })
      .passthrough()
      .optional(),
    limit: z
      .object({
        context: z.number().int().positive().optional(),
        output: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    modalities: z
      .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z.array(modelsDevReasoningOptionSchema).optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
  })
  .passthrough();

const modelsDevCatalogSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), modelsDevModelSchema).optional() }).passthrough(),
);

type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>;

/** Static fallback for providers absent from models.dev. Per-Mtok USD. */
const STATIC_PRICES: Array<{
  provider: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  cacheWriteInputPerMtok: number | null;
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
    cacheWriteInputPerMtok: null,
    perCallUsd: null,
    contextWindow: null,
  },
  {
    provider: "voyage",
    model: "voyage-3.5",
    inputPerMtok: 0.06,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    cacheWriteInputPerMtok: null,
    perCallUsd: null,
    contextWindow: null,
  },
  {
    provider: "voyage",
    model: "rerank-2.5-lite",
    inputPerMtok: 0.05,
    outputPerMtok: 0,
    cachedInputPerMtok: null,
    cacheWriteInputPerMtok: null,
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
  cacheWriteInputPerMtok: number | null;
  perCallUsd: number | null;
  contextWindow: number | null;
  source: string;
  metadata?: Record<string, unknown>;
}

async function fetchCatalog(): Promise<ModelsDevCatalog> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw await httpErrorFromResponse("models.dev", res, { url: MODELS_DEV_URL });
    return modelsDevCatalogSchema.parse(await res.json());
  } finally {
    clearTimeout(timeoutId);
  }
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
        cacheWriteInputPerMtok: cost.cache_write ?? null,
        perCallUsd: null,
        contextWindow: m.limit?.context ?? null,
        source: "models.dev",
        metadata: {
          pricing: {
            // models.dev exposes Anthropic's default 5m cache-write rate. Alfred
            // also uses 1h breakpoints, billed by Anthropic at 2x base input.
            cacheWrite1hPerMtok: provider === "anthropic" ? cost.input * 2 : null,
            tiers:
              cost.tiers?.map((tier) => ({
                minInputTokens: tier.tier.size,
                inputPerMtok: tier.input,
                outputPerMtok: tier.output,
                cachedInputPerMtok: tier.cache_read ?? null,
                cacheWriteInputPerMtok: tier.cache_write ?? null,
                cacheWrite1hPerMtok: provider === "anthropic" ? tier.input * 2 : null,
              })) ?? [],
          } satisfies ModelPricingMetadata,
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
    cacheWriteInputPerMtok: number | null;
    perCallUsd: number | null;
    contextWindow: number | null;
  },
  b: {
    inputPerMtok: number;
    outputPerMtok: number;
    cachedInputPerMtok: number | null;
    cacheWriteInputPerMtok: number | null;
    perCallUsd: number | null;
    contextWindow: number | null;
  },
): boolean {
  return (
    a.inputPerMtok === b.inputPerMtok &&
    a.outputPerMtok === b.outputPerMtok &&
    a.cachedInputPerMtok === b.cachedInputPerMtok &&
    a.cacheWriteInputPerMtok === b.cacheWriteInputPerMtok &&
    a.perCallUsd === b.perCallUsd &&
    a.contextWindow === b.contextWindow
  );
}

/**
 * Compare pricing dimensions and the audited capability subset stored in
 * metadata. Folded into change detection so tier/TTL or capability changes
 * insert a fresh snapshot even when the flat columns are unchanged.
 */
function auditedMetadataEqual(
  latestMetadata: unknown,
  incoming: Record<string, unknown> | undefined,
): boolean {
  const pick = (meta: unknown) => {
    const metadata = isRecord(meta) ? meta : {};
    const caps = isRecord(metadata.capabilities) ? metadata.capabilities : {};
    return JSON.stringify({
      pricing: metadata.pricing ?? null,
      reasoningOptions: caps?.reasoningOptions ?? null,
      temperature: caps?.temperature ?? null,
    });
  };
  return pick(latestMetadata) === pick(incoming);
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeCauseMessage(err: unknown): string | undefined {
  if (!(err instanceof Error) || !("cause" in err)) return undefined;
  const cause = err.cause;
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : undefined;
}

async function upsertIfChanged(row: PriceRow): Promise<"inserted" | "unchanged"> {
  const existing = await db().execute(sql`
    SELECT input_per_mtok, output_per_mtok, cached_input_per_mtok, cache_write_input_per_mtok, per_call_usd, context_window, metadata
    FROM model_prices
    WHERE provider = ${row.provider} AND model = ${row.model}
    ORDER BY valid_from DESC
    LIMIT 1
  `);
  const latest = rowsFromExecute<{
    input_per_mtok: string;
    output_per_mtok: string;
    cached_input_per_mtok: string | null;
    cache_write_input_per_mtok: string | null;
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
          cacheWriteInputPerMtok:
            latest.cache_write_input_per_mtok != null
              ? Number(latest.cache_write_input_per_mtok)
              : null,
          perCallUsd: latest.per_call_usd != null ? Number(latest.per_call_usd) : null,
          contextWindow: latest.context_window,
        },
        row,
      ) && auditedMetadataEqual(latest.metadata, row.metadata);
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
      cacheWriteInputPerMtok:
        row.cacheWriteInputPerMtok != null ? row.cacheWriteInputPerMtok.toString() : null,
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
    console.error("[sync-prices] FAIL:", safeErrorMessage(err));
    const cause = safeCauseMessage(err);
    if (cause) console.error("[sync-prices] cause:", cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeConnections } = await import("../index");
    await closeConnections().catch(() => {});
  });
