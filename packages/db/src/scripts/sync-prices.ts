/**
 * Copy model prices from models.dev into `model_prices` (ADR-0016).
 * Adds a row only when the price changed, so a rerun is safe.
 * `STATIC_PRICES` fills catalog gaps. A catalog row wins over a static one.
 *
 *   $ pnpm --filter @alfred/db db:sync-prices
 */
import { httpErrorFromResponse, isRecord, toMessage } from "@alfred/contracts";
import type { ModelPricingMetadata } from "@alfred/contracts/model-pricing";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, rowsFromExecute } from "../index";
import { modelPrices } from "../schema/metering";
import { auditedMetadataEqual, pricesEqual } from "./sync-prices-compare";

const MODELS_DEV_URL = "https://models.dev/api.json";

const MODELS_DEV_FETCH_TIMEOUT_MS = 30_000;

const PROVIDERS = ["anthropic", "google", "openai", "perplexity"] as const;

/** Stored only so a models.dev change shows in the diff. Runtime does not read it. */
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
        // models.dev reports 0 for image, TTS, and embedding models.
        context: z.number().int().nonnegative().optional(),
        output: z.number().int().nonnegative().optional(),
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

/** USD per 1M tokens. */
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
  // From OpenAI's model page, 2026-09-24. models.dev does not list gpt-6-luna yet.
  {
    provider: "openai",
    model: "gpt-6-luna",
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cachedInputPerMtok: 0.01,
    cacheWriteInputPerMtok: 0.125,
    perCallUsd: null,
    contextWindow: 1_050_000,
    metadata: {
      pricing: {
        cacheWrite1hPerMtok: null,
        tiers: [
          {
            minInputTokens: 272_000,
            inputPerMtok: 0.2,
            cachedInputPerMtok: 0.02,
            cacheWriteInputPerMtok: 0.25,
            cacheWrite1hPerMtok: null,
            outputPerMtok: 0.75,
          },
        ],
      } satisfies ModelPricingMetadata,
    },
  },
  // https://www.voyageai.com/pricing/, 2026-04-30. Input tokens only.
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
    const raw: unknown = await res.json();

    // Parse only PROVIDERS, so a shape change in another provider cannot fail predeploy.
    const scoped = isRecord(raw)
      ? Object.fromEntries(
          PROVIDERS.filter((provider) => provider in raw).map((provider) => [
            provider,
            raw[provider],
          ]),
        )
      : {};

    return modelsDevCatalogSchema.parse(scoped);
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
            // models.dev gives only the 5m cache-write rate. Anthropic bills 1h writes at 2x input.
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
            // Diff snapshot only. The AI SDK owns the runtime mapping (ADR-0078).
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
  const catalogPrices = new Set(fromCatalog.map((row) => `${row.provider}/${row.model}`));

  const fromStatic = STATIC_PRICES.filter(
    (row) => !catalogPrices.has(`${row.provider}/${row.model}`),
  ).map((row) => ({ ...row, source: "static" }));

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
    console.error("[sync-prices] FAIL:", toMessage(err));
    const cause = safeCauseMessage(err);

    if (cause) console.error("[sync-prices] cause:", cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeConnections } = await import("../index");
    await closeConnections().catch(() => {});
  });
