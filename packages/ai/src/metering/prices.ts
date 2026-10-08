import { db } from "@alfred/db";
import { modelPrices } from "@alfred/db/schemas";
import { modelPricingMetadataSchema, type ModelPriceTier } from "@alfred/contracts/model-pricing";
import type { LanguageModel } from "ai";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { identifyLanguageModel } from "../models";
import type { CallUsage } from "./metered";

/** Price cache TTL. A `db:sync-prices` run reaches running workers within minutes. */
const TTL_MS = 5 * 60_000;

interface CachedPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  cacheWriteInputPerMtok: number | null;
  cacheWrite1hPerMtok: number | null;
  tiers: readonly ModelPriceTier[];
  perCallUsd: number | null;
  contextWindow: number | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedPrice>();

export interface PriceLookup {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  cacheWriteInputPerMtok: number | null;
  /** Null when the cache TTL does not change the price. */
  cacheWrite1hPerMtok: number | null;
  /** Higher rates above a provider's context-size threshold. */
  tiers: readonly ModelPriceTier[];
  perCallUsd: number | null;
  /** Max input tokens, from models.dev. Null for embedding models. Compaction uses it (ADR-0035). */
  contextWindow: number | null;
}

function parsePricingMetadata(metadata: unknown) {
  const parsed = z
    .object({ pricing: modelPricingMetadataSchema.optional() })
    .passthrough()
    .safeParse(metadata);

  return parsed.success
    ? (parsed.data.pricing ?? { cacheWrite1hPerMtok: null, tiers: [] })
    : { cacheWrite1hPerMtok: null, tiers: [] };
}

function cacheKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

async function fetchPrice(provider: string, model: string): Promise<PriceLookup | null> {
  const rows = await db()
    .select()
    .from(modelPrices)
    .where(
      and(
        eq(modelPrices.provider, provider),
        eq(modelPrices.model, model),
        lte(modelPrices.validFrom, new Date()),
      ),
    )
    .orderBy(desc(modelPrices.validFrom))
    .limit(1);

  const row = rows[0];

  if (!row) return null;
  const pricing = parsePricingMetadata(row.metadata);

  return {
    inputPerMtok: Number(row.inputPerMtok),
    outputPerMtok: Number(row.outputPerMtok),
    cachedInputPerMtok: row.cachedInputPerMtok != null ? Number(row.cachedInputPerMtok) : null,
    cacheWriteInputPerMtok:
      row.cacheWriteInputPerMtok != null ? Number(row.cacheWriteInputPerMtok) : null,
    cacheWrite1hPerMtok: pricing.cacheWrite1hPerMtok,
    tiers: pricing.tiers,
    perCallUsd: row.perCallUsd != null ? Number(row.perCallUsd) : null,
    contextWindow: row.contextWindow ?? null,
  };
}

export async function getPrice(provider: string, model: string): Promise<PriceLookup | null> {
  const key = cacheKey(provider, model);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return {
      inputPerMtok: cached.inputPerMtok,
      outputPerMtok: cached.outputPerMtok,
      cachedInputPerMtok: cached.cachedInputPerMtok,
      cacheWriteInputPerMtok: cached.cacheWriteInputPerMtok,
      cacheWrite1hPerMtok: cached.cacheWrite1hPerMtok,
      tiers: cached.tiers,
      perCallUsd: cached.perCallUsd,
      contextWindow: cached.contextWindow,
    };
  }

  const fresh = await fetchPrice(provider, model);

  if (!fresh) return null;
  cache.set(key, { ...fresh, fetchedAt: Date.now() });

  return fresh;
}

/** Used only when the DB row has no window, so a fresh checkout boots before the first price sync. */
const FALLBACK_CONTEXT_WINDOWS = {
  "anthropic/claude-sonnet-4-6": 1_000_000,
  "anthropic/claude-opus-4-8": 1_000_000,
  "google/gemini-2.5-flash": 1_048_576,
  "google/gemini-2.5-flash-lite": 1_048_576,
  "google/gemini-3.5-flash": 1_048_576,
  "google/gemini-3.8-flash": 1_048_576,
  "openai/gpt-6-luna": 1_050_000,
} as const satisfies Readonly<Record<string, number>>;

/**
 * The model's context window. Throws for an unknown model: compaction needs it (ADR-0035),
 * and a guessed value could let the transcript grow without bound.
 */
export async function resolveModelContextWindow(model: LanguageModel): Promise<number> {
  const { provider, modelId } = identifyLanguageModel(model);

  return resolveContextWindowById(provider, modelId);
}

/**
 * Boot check: the leg has a `model_prices` row with a nonzero rate.
 * A missing row and an all-zero row both meter at $0.
 */
export async function assertLegPriced(provider: string, modelId: string): Promise<void> {
  const key = `${provider}/${modelId}`;
  const price = await getPrice(provider, modelId);

  if (!price) {
    throw new Error(
      `[metering] no model_prices row for ${key} — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
    );
  }

  if (price.perCallUsd == null && !(price.inputPerMtok > 0) && !(price.outputPerMtok > 0)) {
    throw new Error(
      `[metering] model_prices row for ${key} carries no rates — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
    );
  }

  // Compaction needs a window (ADR-0035). The code fallback is fine here; it cannot hide a cost.
  await resolveContextWindowById(provider, modelId);
}

/** `resolveModelContextWindow` by ids, for the boot guard's per-leg list. */
export async function resolveContextWindowById(provider: string, modelId: string): Promise<number> {
  const price = await getPrice(provider, modelId);

  if (price?.contextWindow != null) return price.contextWindow;
  const key = `${provider}/${modelId}`;

  // SAFETY: the `in` guard proves the key is in the table.
  const fallback =
    key in FALLBACK_CONTEXT_WINDOWS
      ? FALLBACK_CONTEXT_WINDOWS[key as keyof typeof FALLBACK_CONTEXT_WINDOWS]
      : undefined;

  if (fallback != null) {
    console.warn(
      `[metering] using fallback context_window=${fallback} for ${key} — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
    );

    return fallback;
  }

  throw new Error(
    `[metering] no context_window for ${key} — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
  );
}

/** USD cost. 0 when the price is missing; throwing would break the call. */
export function computeCost(price: PriceLookup | null, usage: CallUsage | undefined): number {
  if (!price) return 0;

  if (price.perCallUsd != null) return price.perCallUsd;

  if (!usage) return 0;
  // `inputTokens` includes cache reads and writes. Bill only the rest at the input rate.
  const rates = resolveRates(price, usage.inputTokens ?? 0);
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;

  const uncachedInputTokens =
    usage.noCacheInputTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens - cacheWriteInputTokens);

  const uncachedInput = uncachedInputTokens / 1_000_000;
  const cachedInput = cachedInputTokens / 1_000_000;
  const cacheWriteInput = cacheWriteInputTokens / 1_000_000;
  const output = (usage.outputTokens ?? 0) / 1_000_000;
  const cachedRate = rates.cachedInputPerMtok ?? rates.inputPerMtok;

  const cacheWriteRate =
    usage.cacheWriteTtl === "1h" && rates.cacheWrite1hPerMtok != null
      ? rates.cacheWrite1hPerMtok
      : (rates.cacheWriteInputPerMtok ?? rates.inputPerMtok);

  return (
    uncachedInput * rates.inputPerMtok +
    cachedInput * cachedRate +
    cacheWriteInput * cacheWriteRate +
    output * rates.outputPerMtok
  );
}

function resolveRates(
  price: PriceLookup,
  inputTokens: number,
): Omit<PriceLookup, "contextWindow" | "tiers" | "perCallUsd"> {
  const tier = [...price.tiers]
    .sort((a, b) => b.minInputTokens - a.minInputTokens)
    .find((candidate) => inputTokens > candidate.minInputTokens);

  return tier ?? price;
}

/** Test-only: drop the cache so the next lookup refetches. */
export function _resetPriceCacheForTests(): void {
  cache.clear();
}
